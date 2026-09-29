// Activity (🕘): what happened in the office, newest first, from the server's append-only events log; plus the
// "while you were away" card shown on load when the boss has been gone a while. Nothing here costs tokens.
const activityUI = (() => {
  const modal = wireModal("activityModal", "activityClose", () => markSeen());
  const host = $("activityList");
  const cache = new Map(); // office id → { events (newest first), lastSeen, loaded, failed }
  const checkedAway = new Set();
  const AWAY_MS = 20 * 60e3;
  let filter = "all";

  const FILTERS = {
    all: () => true,
    tasks: (k) => k.startsWith("task_") || k === "run_end",
    people: (k) => k.startsWith("emp_") || ["ask", "question", "hired", "fired", "meeting_start", "meeting_end"].includes(k),
    pm: (k) => k === "pm_woken" || k.startsWith("discovery_") || k.startsWith("idea_") || k === "mode_change",
    cost: (k) => k.startsWith("cap_") || k === "run_end",
  };
  // housekeeping lines do not make the dot light up or the away card appear
  const meaningful = (ev) => !["server_start", "task_edited", "cap_changed"].includes(ev.kind) && ev.by !== "user";
  const emp = (id) => cur()?.employees.get(id);
  const c = () => cache.get(state.office);

  async function load(officeId = state.office) {
    const entry = cache.get(officeId) || { events: [], lastSeen: 0, loaded: false, failed: false };
    cache.set(officeId, entry);
    entry.loading = true; entry.tried = Date.now();
    try {
      const r = await api("GET", `/api/offices/${encodeURIComponent(officeId)}/activity?limit=200`);
      const known = new Set((r.events || []).map((e) => e.id));
      // events that came over the socket while the request was on its way stay
      entry.events = [...entry.events.filter((e) => !known.has(e.id)), ...(r.events || [])].sort((a, b) => b.ts - a.ts || b.id - a.id);
      entry.lastSeen = Number(r.lastSeen) || 0;
      entry.loaded = true; entry.failed = false;
    } catch { entry.failed = true; }
    entry.loading = false;
    if (officeId !== state.office) return;
    dot();
    if (modal.open) render();
    maybeAway();
  }

  function dot() {
    const e = c();
    $("btnActivity").hidden = !!e?.failed && !e.loaded; // no activity log on this server: no button
    $("activityDot").hidden = !e?.loaded || !e.events.some((ev) => ev.ts > e.lastSeen && meaningful(ev));
  }

  async function markSeen() {
    const e = c();
    if (!e?.loaded) return;
    e.lastSeen = Date.now();
    dot();
    $("awayCard").hidden = true;
    try { await api("PUT", officeApi("/activity/seen"), { ts: e.lastSeen }); } catch {}
  }

  // ---------- one event as a sentence ----------
  const nameOf = (id) => (id === "user" ? t("ui.activity.you") : emp(id)?.name || id || "—");
  const statusName = (s) => (tget(`ui.board.status.${s}`) ? t(`ui.board.status.${s}`) : tget(`ui.activity.run.${s}`) ? t(`ui.activity.run.${s}`) : s || "—");
  function sentence(ev) {
    const d = ev.data || {};
    const by = ev.byName || (ev.by ? (ev.by === "office" ? t("ui.activity.office") : nameOf(ev.by)) : "") || ev.empName || t("ui.activity.office");
    const p = { ...d, empName: ev.empName || emp(ev.emp)?.name || "—", taskTitle: ev.taskTitle || "", task: ev.task ?? "", idea: ev.idea ?? "", byName: by };
    if (ev.kind === "task_status") { p.from = statusName(d.from); p.to = statusName(d.to); }
    if (ev.kind === "task_owner") { p.from = d.fromName || nameOf(d.from); p.to = d.toName || nameOf(d.to); }
    if (ev.kind === "task_started" && d.by) p.byName = nameOf(d.by);
    if (ev.kind === "mode_change") { p.from = t(`ui.board.modes.${d.from}`); p.to = t(`ui.board.modes.${d.to}`); }
    if (ev.kind === "run_end") { p.status = statusName(d.status); p.dur = fmtDur(d.durationMs); p.cost = usd(d.cost); }
    if (ev.kind === "cap_reached") { p.what = t(`ui.activity.capWhat.${d.what === "codex" ? "codex" : "daily"}`); p.limit = d.what === "codex" ? fmtTokens(d.limit) : usd(d.limit); }
    const key = `ui.activity.k.${ev.kind}`;
    let s = typeof tget(key) === "string" ? t(key, p) : ev.kind;
    if (ev.kind === "task_status" && d.note) s += ` — ${String(d.note).slice(0, 160)}`;
    return s;
  }
  const colorOf = (ev) => emp(ev.emp)?.color || emp(ev.by)?.color || "var(--idle)";
  const dayLabel = (ts) => new Date(ts).toDateString() === new Date().toDateString() ? t("ui.chat.today") : new Date(ts).toLocaleDateString(LOCALE_TAG, { weekday: "short", day: "numeric", month: "long" });

  // one glyph and one tone per kind: done is green, things waiting on the boss yellow, trouble red
  const ICONS = { task_created: "＋", task_status: "→", task_owner: "⇄", task_started: "▶", task_edited: "✎", idea_new: "💡", idea_promoted: "💡", pm_woken: "★", discovery_start: "🔭", discovery_end: "🔭", mode_change: "⚙", cap_reached: "⛔", cap_changed: "$", emp_error: "⚠", emp_sick: "🤒", ask: "🔐", question: "💬", meeting_start: "🗣", meeting_end: "🗣", hired: "👋", fired: "👋", server_start: "⏻", run_end: "■" };
  const tone = (ev) => {
    if (ev.kind === "emp_error" || ev.kind === "cap_reached" || ev.kind === "emp_sick") return "bad";
    if (ev.kind === "task_status") return ev.data?.to === "done" ? "good" : ev.data?.to === "blocked" ? "bad" : ev.data?.to === "review" ? "warn" : "";
    if (ev.kind === "ask" || ev.kind === "question") return "warn";
    if (ev.kind === "run_end") return ev.data?.status === "error" ? "bad" : "good";
    return "";
  };

  function line(ev, withTime = true) {
    const el = document.createElement("div");
    const tn = tone(ev);
    el.className = "aline" + (ev.task != null || ev.idea != null ? " link" : "") + (tn ? " " + tn : "");
    el.innerHTML = `${withTime ? `<span class="atime">${timeStr(ev.ts)}</span>` : ""}<i class="aico" style="--c:${escapeHtml(colorOf(ev))}">${ICONS[ev.kind] || "•"}</i><span class="atext">${escapeHtml(sentence(ev))}</span>`;
    if (ev.task != null) el.onclick = () => { modal.hide(); $("awayCard").hidden = true; openTask(ev.task); };
    else if (ev.idea != null) el.onclick = () => { modal.hide(); boardUI.show(); document.querySelector('#boardTabs [data-tab="ideas"]')?.click(); };
    return el;
  }

  function renderFilters() {
    const nav = $("activityFilters");
    nav.innerHTML = "";
    for (const f of Object.keys(FILTERS)) {
      const b = document.createElement("button");
      b.type = "button"; b.className = f === filter ? "on" : "";
      const n = c()?.loaded ? c().events.filter((ev) => FILTERS[f](ev.kind)).length : 0;
      b.innerHTML = `${escapeHtml(t(`ui.activity.f.${f}`))}${n ? ` <small>${n}</small>` : ""}`;
      b.onclick = () => { filter = f; render(); };
      nav.appendChild(b);
    }
  }

  function render() {
    renderFilters();
    host.innerHTML = "";
    host.classList.remove("timeline");
    const e = c();
    if (!e?.loaded) { host.innerHTML = `<div class="panel-empty"><div class="muted">${escapeHtml(t(e?.failed ? "ui.activity.unavailable" : "ui.activity.loading"))}</div></div>`; return; }
    const list = e.events.filter((ev) => FILTERS[filter](ev.kind));
    if (!list.length) { host.innerHTML = `<div class="panel-empty"><div class="empty-ico">🕘</div><div class="muted">${escapeHtml(t("ui.activity.empty"))}</div></div>`; return; }
    host.classList.add("timeline");
    let day = null;
    for (const ev of list) {
      const d = new Date(ev.ts).toDateString();
      if (d !== day) { day = d; const h = document.createElement("div"); h.className = "pgroup"; h.textContent = dayLabel(ev.ts); host.appendChild(h); }
      const el = line(ev);
      if (ev.ts > e.lastSeen && meaningful(ev)) el.classList.add("fresh");
      host.appendChild(el);
    }
  }

  // ---------- "while you were away" ----------
  function maybeAway() {
    const e = c();
    if (!e?.loaded || checkedAway.has(state.office)) return;
    checkedAway.add(state.office);
    const now = Date.now();
    if (now - e.lastSeen < AWAY_MS) return;
    const since = e.lastSeen || now - 24 * 3600e3; // never looked: the last day
    const news = e.events.filter((ev) => ev.ts > since && meaningful(ev));
    if (!news.length) return;
    const done = news.filter((ev) => ev.kind === "task_status" && ev.data?.to === "done").length;
    const review = (cur()?.board?.tasks || []).filter((k) => k.status === "review").length;
    const spent = news.filter((ev) => ev.kind === "run_end").reduce((n, ev) => n + (Number(ev.data?.cost) || 0), 0);
    const parts = [];
    if (done) parts.push(t("ui.away.done", { n: done }));
    if (review) parts.push(t("ui.away.review", { n: review }));
    if (spent >= 0.01) parts.push(t("ui.away.spent", { cost: usd(spent) }));
    if (!parts.length) parts.push(t("ui.away.events", { n: news.length }));
    const card = $("awayCard");
    card.innerHTML = `<div class="away-head"><b>${escapeHtml(t("ui.away.title"))}</b><button class="icon-btn small" type="button" title="${escapeHtml(t("ui.away.dismiss"))}">×</button></div><div class="away-sum">${escapeHtml(parts.join(", "))}</div><div class="away-lines"></div><button class="link-btn" type="button">${escapeHtml(t("ui.away.all", { n: news.length }))}</button>`;
    const lines = card.querySelector(".away-lines");
    for (const ev of news.slice(0, 5)) lines.appendChild(line(ev));
    card.querySelector(".icon-btn").onclick = markSeen;
    card.querySelector(".link-btn").onclick = show;
    card.dataset.office = state.office;
    card.hidden = false;
  }

  function show() { $("awayCard").hidden = true; filter = "all"; modal.show(); render(); markSeen(); }

  $("btnActivity").onclick = show;
  panelHooks.push((what, officeId, ev) => {
    if (what === "office") {
      if ($("awayCard").dataset.office !== officeId) $("awayCard").hidden = true;
      const en = cache.get(officeId);
      if (en?.loaded) { dot(); maybeAway(); if (modal.open) render(); }
      else if (!en || (!en.loading && Date.now() - en.tried > 60e3)) load(officeId);
      return;
    }
    if (what !== "activity" || !ev) return;
    const e = cache.get(officeId);
    if (!e?.loaded || e.events.some((x) => x.id === ev.id)) return;
    e.events.unshift(ev);
    if (e.events.length > 400) e.events.length = 400;
    if (officeId !== state.office) return;
    if (modal.open) { e.lastSeen = Math.max(e.lastSeen, ev.ts); render(); }
    dot();
  });
  return { show, load, sentence };
})();
