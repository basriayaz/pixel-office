// Board: the office task list and the shared notebook. Tasks listed here are a plan: nobody starts one until
// the boss presses Start or the project manager starts it. Loaded after app.js, before meeting.js.
// How the office works (manual / cycle / auto) with the budget of a round and rounds per day. One control per place it is
// shown (the board's mode row, Settings → This office); both read the office's board state and stay in sync through the
// "board" broadcast. `els` = { root, mode, budget, rounds, hint, phase, confirm }; isOpen() = the panel holding it is visible.
function makeModeControl(els, isOpen) {
  const board = () => cur()?.board || {};
  const API = () => `/api/offices/${encodeURIComponent(state.office)}/board`;
  function render() {
    const b = board(), mode = b.mode || "manual";
    const sel = els.mode;
    if (!sel.options.length) sel.innerHTML = ["manual", "cycle", "auto"].map((m) => `<option value="${m}">${escapeHtml(t(`ui.board.modes.${m}`))}</option>`).join("");
    if (confirming) sel.value = confirming; // the switch is asked about below; the office still runs as before
    else if (document.activeElement !== sel) sel.value = mode;
    if (document.activeElement !== els.budget && !confirming) els.budget.value = b.budget ?? 10;
    if (document.activeElement !== els.rounds && !confirming) els.rounds.value = b.roundsPerDay ?? 3;
    const shown = confirming || mode;
    els.root.querySelectorAll(".mode-extra").forEach((el) => (el.hidden = shown === "manual"));
    els.hint.textContent = t(`ui.board.modeHint.${shown}`);
    els.hint.hidden = !!confirming; // the question below says it in short
    renderConfirm();
    const c = b.cycle, chip = els.phase;
    chip.hidden = !c || c.phase === "idle";
    if (c && c.phase !== "idle") chip.textContent = t(`ui.board.phase.${c.phase}`, { no: c.no, spent: (c.spent || 0).toFixed(2) });
  }
  // Letting the office run by itself spends money while the boss is away: that switch is confirmed first, in place
  // (no confirm() dialog), with the round budget and today's spending against the daily cap.
  let confirming = null, capInfo = null; // mode waiting for "yes"; { cap, today } or "off" / "none" while loading
  async function askMode(m) {
    confirming = m; capInfo = null;
    render();
    try {
      const c = await api("GET", `/api/offices/${encodeURIComponent(state.office)}/costs?days=1`);
      capInfo = { daily: Number(c?.cap?.daily) || 0, today: Number(c?.today) || 0 };
    } catch { capInfo = "off"; }
    if (confirming === m) renderConfirm();
  }
  function cancel() { if (!confirming) return; confirming = null; if (isOpen()) render(); else renderConfirm(); }
  function renderConfirm() {
    const box = els.confirm;
    if (!confirming) { box.hidden = true; box.innerHTML = ""; return; }
    const budget = Number(els.budget.value) || 10, rounds = Number(els.rounds.value) || 3;
    const cap = capInfo == null ? t("ui.board.drawer.loading") : capInfo === "off" ? t("ui.board.modeConfirm.capUnknown")
      : capInfo.daily ? t("ui.board.modeConfirm.cap", { cap: capInfo.daily.toFixed(2), today: capInfo.today.toFixed(2) }) : t("ui.board.modeConfirm.noCap");
    box.hidden = false;
    box.innerHTML = `<b>${escapeHtml(t("ui.board.modeConfirm.title", { mode: t(`ui.board.modes.${confirming}`) }))}</b>
      <p>${escapeHtml(t(`ui.board.modeConfirm.${confirming}`))}</p>
      <p class="muted">${escapeHtml(t("ui.board.modeConfirm.budget", { budget, rounds }))}<br />${escapeHtml(cap)}</p>
      <div class="actions right"><button class="btn small ghost mc-cancel" type="button">${escapeHtml(t("ui.board.cancel"))}</button><button class="btn small primary mc-ok" type="button">${escapeHtml(t("ui.board.modeConfirm.ok"))}</button></div>`;
    box.querySelector(".mc-cancel").onclick = cancel;
    box.querySelector(".mc-ok").onclick = async () => { const m = confirming; if (!m) return; await save(); if (confirming === m) { confirming = null; render(); } };
  }
  const onModeChange = () => {
    const m = els.mode.value, now = board().mode || "manual";
    if ((m === "auto" || m === "cycle") && m !== now) { if (m !== confirming) askMode(m); return; }
    confirming = null; renderConfirm();
    if (m !== now) save();
  };
  const save = async () => {
    try { await api("PUT", `${API()}/mode`, { mode: els.mode.value, budget: Number(els.budget.value), roundsPerDay: Number(els.rounds.value) }); toast(t("ui.board.modeSaved")); }
    catch (err) { toast(err.message); }
  };
  els.mode.onchange = onModeChange;
  els.budget.onchange = els.rounds.onchange = () => { if (confirming) renderConfirm(); else save(); };
  return { render, cancel, get confirming() { return confirming; } };
}

const boardUI = (() => {
  const STATUSES = ["blocked", "review", "doing", "todo", "done"];
  const STATUS_ICON = { blocked: "⛔", review: "🔍", doing: "⚙", todo: "○", done: "✓" };
  let tab = "tasks", ownerFilter = "", showDone = false, noteFilter = "", ideaShowAll = false;
  const open = new Set();      // expanded task / note ids ("t3", "n7")
  const editing = new Set();   // note ids being edited
  const sendingBack = new Set(); // review tasks whose "send back" reason box is open

  const board = () => ({ tasks: [], notes: [], ideas: [], ...(cur()?.board || {}) });
  const emps = () => [...(cur()?.employees.values() || [])];
  const emp = (id) => cur()?.employees.get(id);
  const who = (id) => (id === "user" ? t("ui.board.you") : emp(id)?.name || id);
  const API = () => `/api/offices/${encodeURIComponent(state.office)}/board`;
  const call = async (method, url, body) => { try { return await api(method, url, body); } catch (err) { toast(err.message); } };
  const when = (ts) => new Date(ts).toLocaleString(LOCALE_TAG, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  // What an open task's owner is up to, when that matters: waiting for the boss's permission, fallen over, gone, or not working at all.
  function alertOf(k) {
    if (k.status === "done") return null;
    const e = emp(k.owner);
    if (!e) return "orphan";
    if (k.status !== "doing") return null;
    if (e.status === "waiting") return "waiting";
    if (e.status === "error") return "error";
    if (e.status === "sick") return "sick";
    if (e.status === "idle" && Date.now() - k.updated > 60e3) return "stalled";
    return null;
  }

  function badge() {
    const n = board().tasks.filter((k) => k.status === "blocked" || k.status === "review" || ["waiting", "error", "orphan", "stalled"].includes(alertOf(k))).length; // what needs the boss
    const fresh = board().ideas.filter((x) => x.status === "new").length; // ideas nobody has decided on yet
    const el = $("boardBadge");
    el.hidden = !(n + fresh); el.textContent = n + fresh;
    $("ideasBadge").hidden = !fresh; $("ideasBadge").textContent = fresh;
    $("tasksBadge").hidden = !n; $("tasksBadge").textContent = n;
  }

  // Employee status only shows on the board through task alerts; this fingerprint tells whether a status change matters.
  const alertSig = () => board().tasks.map((k) => `${k.id}:${alertOf(k) || ""}`).join(",");
  let shownSig = "";

  let deepLink = params.get("board"); // /?board=tasks or /?board=notes opens the panel straight away; &task=3 also opens that task's drawer
  let drawerId = params.get("task") ? Number(params.get("task")) : null; // the task shown in the side drawer
  // reason "status": an employee's status changed (or the clock ticked), which only matters for alerts on the task list
  function refresh(officeId, reason) {
    if (officeId && officeId !== state.office) return;
    badge();
    if (deepLink && cur()?.board) { tab = ["notes", "ideas"].includes(deepLink) ? deepLink : "tasks"; deepLink = null; show(); return; }
    if ($("boardModal").hidden) return; // closed: show() renders fresh when it opens
    if (reason === "status" && (tab !== "tasks" || alertSig() === shownSig)) return;
    softRender();
  }

  // Background updates wait while the boss is typing or choosing in the board, so half-typed text and open selects survive;
  // what was typed into a card is also kept in `drafts` across re-renders.
  const drafts = new Map(); // "i-comment:4" → text
  let pending = false, pointerDown = 0;
  const busy = () => {
    if (pointerDown && Date.now() - pointerDown < 2000) return true; // mid-click: do not pull the button away
    const a = document.activeElement;
    if (!a || !(a.closest("#taskList, #ideaList, #noteList, #taskDrawer") || a.id === "taskOwnerFilter" || a.id === "noteAuthorFilter")) return false;
    if (a.tagName === "SELECT") return !a.dataset.changed; // an open dropdown; once a choice is made the update may land
    return (a.tagName === "INPUT" && a.type !== "checkbox") || a.tagName === "TEXTAREA";
  };
  function softRender() {
    if (busy()) { pending = true; return; }
    pending = false;
    render();
  }
  const flush = () => { if (pending && !$("boardModal").hidden) softRender(); };
  const modal = $("boardModal");
  modal.addEventListener("pointerdown", () => { pointerDown = Date.now(); });
  for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, () => { if (pointerDown) { pointerDown = 0; setTimeout(flush, 300); } });
  modal.addEventListener("focusin", (ev) => { if (ev.target.tagName === "SELECT") delete ev.target.dataset.changed; });
  modal.addEventListener("change", (ev) => { if (ev.target.tagName === "SELECT") { ev.target.dataset.changed = "1"; setTimeout(flush, 0); } });
  modal.addEventListener("focusout", () => setTimeout(flush, 300));
  modal.addEventListener("input", (ev) => { const k = ev.target.dataset?.draft; if (k) drafts.set(k, ev.target.value); });
  setInterval(flush, 2000); // failsafe for a lost pointerup
  const draft = (k, fallback) => (drafts.has(k) ? drafts.get(k) : fallback);

  function show() { $("boardModal").hidden = false; pending = false; render(); }
  function hide() { $("boardModal").hidden = true; drawerId = null; cancelMode(); }

  function render() {
    shownSig = alertSig();
    document.querySelectorAll("#boardTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    $("boardTasks").hidden = tab !== "tasks";
    $("boardNotes").hidden = tab !== "notes";
    $("boardIdeas").hidden = tab !== "ideas";
    renderMode();
    const mgr = emps().find((e) => e.manager);
    $("boardManager").textContent = mgr ? t("ui.board.managerIs", { name: mgr.name }) : t("ui.board.noManager");
    if (tab === "tasks") renderTasks(); else { renderDrawer(); if (tab === "ideas") renderIdeas(); else renderNotes(); }
  }

  const ownerOptions = (selected, withAll) => (withAll ? `<option value="">${escapeHtml(t("ui.board.filterAll"))}</option>` : "") + emps().map((e) => `<option value="${escapeHtml(e.id)}"${e.id === selected ? " selected" : ""}>${escapeHtml(e.name)} — ${escapeHtml(e.role)}</option>`).join("");

  // ---------- tasks ----------
  function renderTasks() { renderTaskList(); renderDrawer(); }
  function renderTaskList() {
    $("taskOwnerFilter").innerHTML = ownerOptions(ownerFilter, true);
    $("taskShowDone").checked = showDone;
    if (!$("newTaskOwner").options.length || [...$("newTaskOwner").options].length !== emps().length) $("newTaskOwner").innerHTML = ownerOptions($("newTaskOwner").value, false);
    const host = $("taskList");
    host.innerHTML = "";
    let tasks = board().tasks.filter((k) => !ownerFilter || k.owner === ownerFilter);
    // with one person selected: a single "do your open tasks" instead of starting each task separately
    const waiting = ownerFilter ? tasks.filter((k) => k.status === "todo").length : 0;
    const all = $("taskStartAll");
    all.hidden = !waiting || !emp(ownerFilter);
    if (waiting && emp(ownerFilter)) {
      all.textContent = t("ui.board.startAll", { name: emp(ownerFilter).name, n: waiting });
      all.onclick = async () => { if (await call("POST", `${API()}/start-all`, { owner: ownerFilter })) toast(t("ui.board.startedAll", { name: emp(ownerFilter).name })); };
    }
    if (!tasks.length) { host.innerHTML = `<div class="board-empty"><div class="empty-ico">📋</div><div class="muted">${escapeHtml(t("ui.board.noTasks"))}</div></div>`; return; }
    for (const st of STATUSES) {
      if (st === "done" && !showDone) continue;
      const group = tasks.filter((k) => k.status === st).sort((a, b) => b.updated - a.updated);
      if (!group.length) continue;
      const h = document.createElement("div");
      h.className = "board-group " + st;
      h.innerHTML = `<i class="gico">${STATUS_ICON[st]}</i>${escapeHtml(t(`ui.board.status.${st}`))} <span>${group.length}</span>`;
      host.appendChild(h);
      for (const k of group) host.appendChild(taskCard(k));
    }
    const doneCount = tasks.filter((k) => k.status === "done").length;
    if (!showDone && doneCount) { const m = document.createElement("div"); m.className = "muted board-more"; m.textContent = `${t("ui.board.status.done")}: ${doneCount}`; host.appendChild(m); }
  }

  function taskCard(k) {
    const owner = emp(k.owner);
    const card = document.createElement("div");
    card.className = "task-card " + k.status + (drawerId === k.id ? " selected" : "");
    const last = k.notes[k.notes.length - 1];
    const alert = alertOf(k);
    if (alert) card.classList.add("alert-" + alert);
    const chips = `<span class="mchip who">${escapeHtml(owner?.name || t("ui.board.noOwner"))}</span><span class="mchip">${escapeHtml(t("ui.board.by", { name: who(k.createdBy) }))}</span><span class="mchip">${when(k.updated)}</span>`;
    card.style.setProperty("--c", owner?.color || "var(--idle)");
    card.innerHTML = `
      <div class="task-head">
        <span class="pav">${owner ? `<img src="${office.portrait(k.owner)}" alt="" />` : `<span class="prow-icon">·</span>`}</span>
        <div class="task-main"><div class="task-title"><b>#${k.id}</b> ${escapeHtml(k.title)}${taskTags(k, alert)}</div>
          <div class="task-meta">${chips}</div>
          ${last ? `<div class="task-quote">${escapeHtml(last.text.slice(0, 140))}</div>` : ""}</div>
        <div class="task-actions"></div>
      </div>
      ${drawerId !== k.id ? sendBackBox(k) : ""}`;
    // the row opens the task in the side drawer (a second click closes it)
    card.querySelector(".task-main").onclick = () => { drawerId = drawerId === k.id ? null : k.id; renderTasks(); };
    taskButtons(k, card.querySelector(".task-actions"), false);
    wireSendBack(card, k);
    return card;
  }

  const taskTags = (k, alert) => `${k.review ? ` <span class="tag" title="${escapeHtml(t("ui.board.reviewHint"))}">${escapeHtml(t("ui.board.reviewTag"))}</span>` : ""}${k.kind === "discovery" ? ` <span class="tag">${escapeHtml(t("ui.board.kindDiscovery"))}</span>` : ""}${k.after?.length ? ` <span class="tag" title="${escapeHtml(t("ui.board.afterHint"))}">${escapeHtml(t("ui.board.afterTag", { ids: k.after.map((d) => "#" + d).join(", ") }))}</span>` : ""}${k.autoStart && k.status === "todo" ? ` <span class="tag" title="${escapeHtml(t("ui.board.queuedHint"))}">${escapeHtml(t("ui.board.queuedTag"))}</span>` : ""}${alert ? ` <span class="tag alert">${escapeHtml(t(`ui.board.alert.${alert}`))}</span>` : ""}`;

  const sendBackBox = (k) => (k.status === "review" && sendingBack.has(k.id) ? `<div class="send-back"><input class="t-back-reason" data-draft="t-back:${k.id}" maxlength="2000" placeholder="${escapeHtml(t("ui.board.sendBackPh"))}" value="${escapeHtml(draft(`t-back:${k.id}`, ""))}" /><button class="btn small ghost t-back-cancel" type="button">${escapeHtml(t("ui.board.cancel"))}</button><button class="btn small primary t-back-go" type="button">${escapeHtml(t("ui.board.sendBack"))}</button></div>` : "");

  function wireSendBack(root, k) {
    const backBox = root.querySelector(".send-back");
    if (!backBox) return;
    const reason = backBox.querySelector(".t-back-reason");
    const close = () => { sendingBack.delete(k.id); drafts.delete(`t-back:${k.id}`); renderTasks(); };
    const go = async () => { if (await call("PUT", `${API()}/tasks/${k.id}`, { status: "todo", ...(reason.value.trim() ? { note: reason.value.trim() } : {}) })) { toast(t("ui.board.sentBack", { id: k.id })); close(); } };
    backBox.querySelector(".t-back-cancel").onclick = close;
    backBox.querySelector(".t-back-go").onclick = go;
    reason.onkeydown = (ev) => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); go(); } else if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
  }

  // The same buttons on the row and in the drawer; the drawer also gets "Stop" for a task that is running now.
  function taskButtons(k, actions, inDrawer) {
    const owner = emp(k.owner), alert = alertOf(k);
    const btn = (label, cls, fn, tip) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn small " + cls; b.textContent = label; if (tip) b.title = tip; b.onclick = (ev) => { ev.stopPropagation(); fn(); }; actions.appendChild(b); return b; };
    if (alert === "waiting" || alert === "error") btn(t("ui.board.openChat"), "always", () => { hide(); openChat(k.owner); });
    if (alert === "stalled") btn(t("ui.board.restart"), "ghost", async () => { if (await call("POST", `${API()}/tasks/${k.id}/start`)) toast(t("ui.board.started", { id: k.id, name: owner?.name || k.owner })); }, t("ui.board.startTip"));
    // a task that waits for others is not started by hand while they are open (the status select still can)
    const waitsFor = (k.after || []).filter((d) => board().tasks.some((x) => x.id === d && x.status !== "done"));
    if (owner && (k.status === "todo" || k.status === "blocked")) btn(t("ui.board.start"), "primary", async () => { if (await call("POST", `${API()}/tasks/${k.id}/start`)) toast(t("ui.board.started", { id: k.id, name: owner?.name || k.owner })); }, waitsFor.length ? t("ui.board.afterHint") : t("ui.board.startTip")).disabled = !!waitsFor.length;
    if (inDrawer && k.status === "doing" && owner && ["working", "waiting", "compacting"].includes(owner.status)) btn(t("ui.board.drawer.stop"), "no", () => { send({ type: "interrupt", id: k.owner }); toast(t("ui.board.drawer.stopped", { id: k.id })); }, t("ui.board.drawer.stopTip"));
    // "send back" asks why first (optional): the reason becomes a note on the task, and the owner gets it when they resume
    if (k.status === "review" && !sendingBack.has(k.id)) btn(t("ui.board.sendBack"), "ghost", () => { sendingBack.add(k.id); renderTasks(); setTimeout(() => document.querySelector(`[data-draft="t-back:${k.id}"]`)?.focus(), 0); });
    if (k.status === "review" || k.status === "doing") btn(t(k.status === "review" ? "ui.board.approve" : "ui.board.markDone"), "ok", () => call("PUT", `${API()}/tasks/${k.id}`, { status: "done" }));
    if (k.status === "done") btn(t("ui.board.reopen"), "ghost", () => call("PUT", `${API()}/tasks/${k.id}`, { status: "todo" }));
  }

  // ---------- task drawer: everything about one task on the right side of the board ----------
  const runsCache = new Map(); // task id → { at: task.updated when fetched, data? , off?: text }
  const tsCache = new Map();   // task id → { data?, off?, loading? }
  let tsOpen = false;          // the transcript section is unfolded (stays so while the boss moves between tasks)
  const toolOpen = new Set();  // unfolded tool lines "id:index", kept across re-renders

  async function getJSON(url) {
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status });
    return data;
  }
  const offText = (err) => (err.status === 404 ? t("ui.board.drawer.notYet") : err.message);

  async function loadRuns(k) {
    runsCache.set(k.id, { at: k.updated, loading: true });
    let v;
    try { v = { at: k.updated, data: await getJSON(`${API()}/tasks/${k.id}/runs`) }; } catch (err) { v = { at: k.updated, off: offText(err) }; }
    runsCache.set(k.id, v);
    if (drawerId === k.id) renderDrawer();
  }
  async function loadTranscript(id) {
    tsCache.set(id, { loading: true });
    renderDrawer();
    let v;
    try { v = { data: await getJSON(`${API()}/tasks/${id}/transcript`) }; } catch (err) { v = { off: offText(err) }; }
    tsCache.set(id, v);
    if (drawerId === id) { renderDrawer(); const box = $("taskDrawer").querySelector(".drawer-ts-list"); if (box) box.scrollTop = box.scrollHeight; }
  }

  const dur = (ms) => { const s = Math.round((ms || 0) / 1000); return s < 60 ? t("ui.board.drawer.durS", { n: s }) : s < 3600 ? t("ui.board.drawer.durM", { n: Math.round(s / 60) }) : t("ui.board.drawer.durH", { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) }); };
  const money = (c) => "$" + (Number(c) || 0).toFixed(2);
  const tokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
  // does `from` (through its prerequisites) already wait for `target`? then `target` cannot wait for `from`
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (board().tasks.find((x) => x.id === from)?.after || []).some((d) => reaches(d, target, seen));
  };

  function runsHtml(k) {
    const r = runsCache.get(k.id);
    if (!r || r.loading) return `<div class="muted drawer-empty">${escapeHtml(t("ui.board.drawer.loading"))}</div>`;
    if (r.off) return `<div class="muted drawer-empty">${escapeHtml(r.off)}</div>`;
    const runs = r.data?.runs || [];
    if (!runs.length) return `<div class="muted drawer-empty">${escapeHtml(t("ui.board.drawer.noRuns"))}</div>`;
    const tot = r.data.total || {};
    const cost = (x) => (x.codexTokens ? t("ui.board.drawer.tokens", { n: tokens(x.codexTokens) }) : money(x.cost));
    const dotOf = (st) => (st === "done" ? "done" : st === "review" ? "review" : st === "error" || st === "blocked" ? "blocked" : "todo");
    return runs.slice().reverse().map((x) => `<div class="drawer-run"><i class="tdot ${dotOf(x.status)}"></i><span class="drawer-run-when">${when(x.startedAt || x.endedAt)}</span><span class="drawer-run-who">${escapeHtml(x.empName || who(x.emp))}</span><span>${dur(x.durationMs)}</span><span class="drawer-run-cost">${cost(x)}</span><span class="tag">${escapeHtml(t(`ui.board.drawer.run.${x.status}`))}</span></div>`).join("")
      + `<div class="drawer-total">${escapeHtml(t("ui.board.drawer.total", { n: runs.length, time: dur(tot.durationMs), cost: money(tot.cost) }))}${tot.codexTokens ? " · " + escapeHtml(t("ui.board.drawer.tokens", { n: tokens(tot.codexTokens) })) : ""}</div>`;
  }

  function transcriptHtml(k) {
    const v = tsCache.get(k.id);
    if (!v || v.loading) return `<div class="muted drawer-empty">${escapeHtml(t("ui.board.drawer.loading"))}</div>`;
    if (v.off) return `<div class="muted drawer-empty">${escapeHtml(v.off)}</div>`;
    const d = v.data || {};
    if (!d.available) return `<div class="muted drawer-empty">${escapeHtml(d.reason || t("ui.board.drawer.tsOff"))}</div>`;
    const msgs = d.messages || [];
    if (!msgs.length) return `<div class="muted drawer-empty">${escapeHtml(t("ui.board.drawer.tsEmpty"))}</div>`;
    const ownerName = emp(k.owner)?.name || k.owner;
    return `<div class="drawer-ts-list">${msgs.map((m, i) => {
      if (m.role === "tool") {
        const first = String(m.text || "").split("\n")[0].slice(0, 90);
        return `<details class="drawer-tool" data-tool="${k.id}:${i}"${toolOpen.has(`${k.id}:${i}`) ? " open" : ""}><summary>🔧 <b>${escapeHtml(m.tool || t("ui.board.drawer.tool"))}</b> <span>${escapeHtml(first)}</span></summary><pre>${escapeHtml(m.text || "")}</pre></details>`;
      }
      const label = m.role === "user" ? t("ui.board.drawer.roleUser") : ownerName;
      return `<div class="task-note${m.role === "user" ? " drawer-in" : ""}"><span>${escapeHtml(label)}${m.ts ? " · " + when(m.ts) : ""}</span>${md(m.text || "")}</div>`;
    }).join("")}</div>`;
  }

  function renderDrawer() {
    const el = $("taskDrawer"), cardEl = el.parentElement;
    const k = tab === "tasks" && drawerId != null ? board().tasks.find((x) => x.id === drawerId) : null;
    if (!k && drawerId != null && cur()?.board) drawerId = null; // deleted, or another office
    cardEl.classList.toggle("drawer-open", !!k);
    if (!k) { el.hidden = true; el.innerHTML = ""; return; }
    const keepScroll = el.hidden ? 0 : el.scrollTop;
    if (el.hidden) cardEl.scrollTop = 0;
    el.hidden = false;
    const r = runsCache.get(k.id);
    if (!r || (!r.loading && r.at !== k.updated)) loadRuns(k); // fetched once per change of the task, not polled
    if (tsOpen && !tsCache.has(k.id)) loadTranscript(k.id);
    const owner = emp(k.owner), alert = alertOf(k), running = k.status === "doing";
    const others = board().tasks.filter((x) => x.id !== k.id);
    const deps = (k.after || []).map((d) => { const x = others.find((o) => o.id === d); return `<span class="chip dep${x?.status === "done" ? " working" : ""}" title="${escapeHtml(x?.title || "")}">#${d} ${x?.status === "done" ? "✓" : "…"}<button type="button" class="d-dep-del" data-id="${d}" title="${escapeHtml(t("ui.board.drawer.depRemove"))}">×</button></span>`; }).join("");
    const candidates = others.filter((x) => x.status !== "done" && !(k.after || []).includes(x.id) && !reaches(x.id, k.id));
    el.innerHTML = `
      <div class="drawer-head"><i class="tdot ${k.status}"></i><b>#${k.id}</b><span class="muted">${escapeHtml(t(`ui.board.status.${k.status}`))}</span><span class="drawer-tags">${taskTags({ ...k, after: [] }, alert)}</span><button class="icon-btn small d-close" type="button" title="${escapeHtml(t("ui.board.close"))}">×</button></div>
      <div class="task-meta">${escapeHtml(t("ui.board.by", { name: who(k.createdBy) }))} · ${when(k.created)} · ${escapeHtml(t("ui.board.drawer.updated", { when: when(k.updated) }))}</div>
      <label class="drawer-field"><span>${escapeHtml(t("ui.board.taskTitle"))}</span><input class="d-title" data-draft="d-title:${k.id}" maxlength="160" value="${escapeHtml(draft(`d-title:${k.id}`, k.title))}" /></label>
      <label class="drawer-field"><span>${escapeHtml(t("ui.board.drawer.detail"))}</span><textarea class="d-detail" data-draft="d-detail:${k.id}" rows="5" maxlength="8000" placeholder="${escapeHtml(t("ui.board.taskDetail"))}">${escapeHtml(draft(`d-detail:${k.id}`, k.detail || ""))}</textarea></label>
      <div class="drawer-save"><button class="btn small ghost d-revert" type="button">${escapeHtml(t("ui.board.cancel"))}</button><button class="btn small primary d-save" type="button">${escapeHtml(t("ui.board.save"))}</button></div>
      <div class="task-edit">
        <select class="d-status" title="${escapeHtml(t("ui.board.drawer.status"))}">${STATUSES.slice().reverse().map((s) => `<option value="${s}"${s === k.status ? " selected" : ""}>${escapeHtml(t(`ui.board.status.${s}`))}</option>`).join("")}</select>
        <select class="d-owner"${running ? ` disabled title="${escapeHtml(t("ui.board.drawer.ownerLocked"))}"` : ` title="${escapeHtml(t("ui.board.owner"))}"`}>${owner ? "" : `<option value="" selected>${escapeHtml(t("ui.board.noOwner"))}</option>`}${ownerOptions(k.owner, false)}</select>
        <label class="check"><input type="checkbox" class="d-review"${k.review ? " checked" : ""} /> <span>${escapeHtml(t("ui.board.needsReview"))}</span></label>
      </div>
      <div class="drawer-field"><span>${escapeHtml(t("ui.board.drawer.deps"))}</span>
        <div class="drawer-deps">${deps || `<small class="muted">${escapeHtml(t("ui.board.drawer.noDeps"))}</small>`}${candidates.length ? `<select class="d-dep-add"><option value="">${escapeHtml(t("ui.board.drawer.depAdd"))}</option>${candidates.map((x) => `<option value="${x.id}">#${x.id} ${escapeHtml(x.title.slice(0, 60))}</option>`).join("")}</select>` : ""}</div></div>
      <div class="drawer-actions"><span class="task-actions"></span><button class="btn small danger d-del" type="button">${escapeHtml(t("ui.board.delete"))}</button></div>
      ${sendBackBox(k)}
      <h4>${escapeHtml(t("ui.board.drawer.notes"))} <span>${k.notes.length}</span></h4>
      ${k.notes.length ? `<div class="drawer-notes">${k.notes.map((n) => `<div class="task-note"><span>${escapeHtml(who(n.by))} · ${when(n.ts)}</span>${escapeHtml(n.text)}</div>`).join("")}</div>` : `<div class="muted drawer-empty">${escapeHtml(t("ui.board.drawer.noNotes"))}</div>`}
      <h4>${escapeHtml(t("ui.board.drawer.runs"))}</h4>
      ${runsHtml(k)}
      <details class="drawer-ts"${tsOpen ? " open" : ""}><summary><h4>${escapeHtml(t("ui.board.drawer.transcript"))}</h4>${tsOpen ? `<button type="button" class="link-btn d-ts-reload">${escapeHtml(t("ui.board.drawer.reload"))}</button>` : ""}</summary>${tsOpen ? transcriptHtml(k) : ""}</details>`;
    el.scrollTop = keepScroll;
    taskButtons(k, el.querySelector(".task-actions"), true);
    wireSendBack(el, k);
    const put = (body) => call("PUT", `${API()}/tasks/${k.id}`, body);
    el.querySelector(".d-close").onclick = () => { drawerId = null; renderTasks(); };
    const forget = () => { drafts.delete(`d-title:${k.id}`); drafts.delete(`d-detail:${k.id}`); };
    el.querySelector(".d-revert").onclick = () => { forget(); renderDrawer(); };
    el.querySelector(".d-save").onclick = async () => {
      const title = el.querySelector(".d-title").value.trim();
      if (!title) { el.querySelector(".d-title").focus(); return; }
      const detail = el.querySelector(".d-detail").value;
      document.activeElement?.blur(); // the board holds updates while a field has focus; after saving it may re-render
      if (await put({ title, detail })) { forget(); toast(t("ui.board.saved")); }
    };
    el.querySelector(".d-status").onchange = (ev) => put({ status: ev.target.value });
    el.querySelector(".d-owner").onchange = (ev) => { if (ev.target.value) put({ owner: ev.target.value, ...(k.status === "blocked" && !owner ? { status: "todo" } : {}) }); };
    el.querySelector(".d-review").onchange = (ev) => put({ review: ev.target.checked });
    const addDep = el.querySelector(".d-dep-add");
    if (addDep) addDep.onchange = () => { if (addDep.value) put({ after: [...(k.after || []), Number(addDep.value)] }); };
    el.querySelectorAll(".d-dep-del").forEach((b) => (b.onclick = () => put({ after: (k.after || []).filter((d) => d !== Number(b.dataset.id)) })));
    const del = el.querySelector(".d-del");
    del.onclick = () => { if (del.dataset.armed) call("DELETE", `${API()}/tasks/${k.id}`); else { del.dataset.armed = "1"; del.textContent = t("ui.board.deleteConfirm"); setTimeout(() => { delete del.dataset.armed; del.textContent = t("ui.board.delete"); }, 3000); } };
    const ts = el.querySelector(".drawer-ts");
    ts.ontoggle = () => { if (ts.open === tsOpen) return; tsOpen = ts.open; if (tsOpen && !tsCache.has(k.id)) loadTranscript(k.id); else renderDrawer(); };
    el.querySelector(".d-ts-reload")?.addEventListener("click", (ev) => { ev.preventDefault(); loadTranscript(k.id); });
    el.querySelectorAll(".drawer-tool").forEach((d) => (d.ontoggle = () => { d.open ? toolOpen.add(d.dataset.tool) : toolOpen.delete(d.dataset.tool); }));
  }

  // Other panels (inbox, activity) open a task here: the board on its task list, with the drawer on that task.
  window.openTaskDrawer = (id) => {
    tab = "tasks"; drawerId = Number(id);
    if (!cur()?.board) { deepLink = "tasks"; return; } // the board arrives with the office; refresh() opens it then
    show();
  };

  // ---------- how the office works: by hand, approved rounds, on its own (the same control sits in Settings → This office) ----------
  const modeCtl = makeModeControl({ root: $("boardMode"), mode: $("officeMode"), budget: $("officeBudget"), rounds: $("officeRounds"), hint: $("officeModeHint"), phase: $("cyclePhase"), confirm: $("modeConfirm") }, () => !$("boardModal").hidden);
  const renderMode = () => modeCtl.render();
  const cancelMode = () => modeCtl.cancel();

  // ---------- ideas: suggestions waiting for the boss; "move" makes one a task ----------
  const ideaOwner = new Map(); // idea id → owner chosen in the card
  function renderIdeas() {
    $("ideaShowAll").checked = ideaShowAll;
    const host = $("ideaList");
    host.innerHTML = "";
    const order = { new: 0, later: 1, moved: 2, rejected: 3 };
    const ideas = board().ideas.filter((x) => ideaShowAll || x.status === "new" || x.status === "later").slice().sort((a, b) => order[a.status] - order[b.status] || (a.rank ?? 999) - (b.rank ?? 999) || b.ts - a.ts);
    if (!ideas.length) { host.innerHTML = `<div class="board-empty"><div class="empty-ico">💡</div><div class="muted">${escapeHtml(t("ui.board.noIdeas"))}</div></div>`; return; }
    for (const x of ideas) host.appendChild(ideaCard(x));
  }

  function ideaCard(x) {
    const ranked = board().ideas.some((i) => i.rank && i.status === "new");
    const key = "i" + x.id, isOpen = open.has(key) ? !(x.status === "new" && (!ranked || x.rank)) : x.status === "new" && (!ranked || !!x.rank);
    const card = document.createElement("div");
    card.className = "idea-card st-" + x.status + (isOpen ? " open" : "") + (x.rank === 1 && x.status === "new" ? " top" : "");
    const avatar = `<span class="pav">${x.by !== "user" && emp(x.by) ? `<img src="${office.portrait(x.by)}" alt="" />` : `<span class="prow-icon">★</span>`}</span>`;
    const chosen = ideaOwner.get(x.id) ?? x.owner ?? "";
    const live = x.status === "new" || x.status === "later";
    const pills = `<span class="pill st-${x.status}">${escapeHtml(t(`ui.board.ideaStatus.${x.status}`))}</span>${x.rank && x.status !== "moved" ? `<span class="pill rank" title="${escapeHtml(t("ui.board.ideaRankHint"))}">${escapeHtml(t("ui.board.ideaRank", { n: x.rank }))}</span>` : ""}${x.effort ? `<span class="pill eff">${escapeHtml(t(`ui.board.ideaEffort.${x.effort}`))}</span>` : ""}${x.taskId ? `<span class="pill">${escapeHtml(t("ui.board.ideaMoved", { id: x.taskId }))}</span>` : ""}`;
    card.innerHTML = `<div class="note-head"><span class="idea-bulb">💡</span><div class="task-main"><div class="task-title"><b>#${x.id}</b> ${escapeHtml(x.title)}</div><div class="idea-pills">${pills}</div></div></div>
      ${x.text ? `<div class="note-text${isOpen ? "" : " clamp"}">${md(x.text)}</div>` : ""}
      ${x.advice ? `<div class="idea-advice"><span>${escapeHtml(t("ui.board.ideaAdvice"))}</span>${escapeHtml(x.advice)}</div>` : ""}
      <div class="idea-foot"><span class="idea-by">${avatar}<span>${escapeHtml(x.byName)} · ${when(x.ts)}</span>${x.tags.map((g) => `<span class="mchip">${escapeHtml(g)}</span>`).join("")}</span>${x.comment && !isOpen ? `<span class="idea-comment">${escapeHtml(x.comment)}</span>` : ""}</div>
      <div class="note-actions"${isOpen ? "" : " hidden"}>${live ? `<select class="i-owner"><option value="">${escapeHtml(t("ui.board.ideaOwner"))}…</option>${ownerOptions(chosen, false)}</select><input class="i-comment" data-draft="i-comment:${x.id}" maxlength="600" placeholder="${escapeHtml(t("ui.board.ideaComment"))}" value="${escapeHtml(draft(`i-comment:${x.id}`, x.comment || ""))}" />` : ""}<span class="i-buttons"></span></div>`;
    card.querySelector(".note-head").onclick = () => { open.has(key) ? open.delete(key) : open.add(key); renderIdeas(); };
    const buttons = card.querySelector(".i-buttons");
    const btn = (label, cls, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn small " + cls; b.textContent = label; b.onclick = fn; buttons.appendChild(b); };
    const comment = () => card.querySelector(".i-comment")?.value.trim() ?? "";
    const act = async (fn) => { const r = await fn(); if (r) drafts.delete(`i-comment:${x.id}`); return r; };
    if (live) {
      card.querySelector(".i-owner").onchange = (ev) => ideaOwner.set(x.id, ev.target.value);
      const move = async (start) => {
        const owner = card.querySelector(".i-owner").value;
        if (!owner) { toast(t("ui.board.ideaPickOwner")); return; }
        if (comment() !== (x.comment || "")) await call("PUT", `${API()}/ideas/${x.id}`, { comment: comment() });
        const k = await act(() => call("POST", `${API()}/ideas/${x.id}/promote`, { owner, start }));
        if (k) toast(t("ui.board.ideaMovedToast", { id: k.id }));
      };
      btn(t("ui.board.ideaMove"), "primary", () => move(false));
      btn(t("ui.board.ideaMoveStart"), "ok", () => move(true));
      if (x.status === "new") btn(t("ui.board.ideaLater"), "ghost", () => act(() => call("PUT", `${API()}/ideas/${x.id}`, { status: "later", comment: comment() })));
      btn(t("ui.board.ideaReject"), "danger", () => act(() => call("PUT", `${API()}/ideas/${x.id}`, { status: "rejected", comment: comment() })));
    } else {
      if (x.status === "rejected") btn(t("ui.board.ideaReopen"), "ghost", () => call("PUT", `${API()}/ideas/${x.id}`, { status: "new" }));
      btn(t("ui.board.delete"), "danger", () => call("DELETE", `${API()}/ideas/${x.id}`));
    }
    return card;
  }

  // ---------- notes ----------
  function renderNotes() {
    const authors = new Map(board().notes.map((n) => [n.by, n.byName]));
    $("noteAuthorFilter").innerHTML = `<option value="">${escapeHtml(t("ui.board.filterAll"))}</option>` + [...authors].map(([id, name]) => `<option value="${escapeHtml(id)}"${id === noteFilter ? " selected" : ""}>${escapeHtml(name)}</option>`).join("");
    const host = $("noteList");
    host.innerHTML = "";
    const notes = board().notes.filter((n) => !noteFilter || n.by === noteFilter).slice().reverse();
    $("notesCount").textContent = t("ui.board.notesCount", { n: notes.length });
    if (!notes.length) { host.innerHTML = `<div class="board-empty"><div class="empty-ico">📒</div><div class="muted">${escapeHtml(t("ui.board.noNotes"))}</div></div>`; return; }
    for (const n of notes) host.appendChild(noteCard(n));
  }

  function noteCard(n) {
    const key = "n" + n.id, isOpen = open.has(key), isEdit = editing.has(n.id);
    const card = document.createElement("div");
    card.className = "note-card" + (isOpen ? " open" : "");
    card.style.setProperty("--c", emp(n.by)?.color || "var(--accent)");
    const avatar = `<span class="pav">${n.by !== "user" && emp(n.by) ? `<img src="${office.portrait(n.by)}" alt="" />` : `<span class="prow-icon">★</span>`}</span>`;
    if (isEdit) {
      card.innerHTML = `<input class="n-title" data-draft="n-title:${n.id}" maxlength="140" value="${escapeHtml(draft(`n-title:${n.id}`, n.title))}" /><textarea class="n-text" data-draft="n-text:${n.id}" rows="6">${escapeHtml(draft(`n-text:${n.id}`, n.text))}</textarea><input class="n-tags" data-draft="n-tags:${n.id}" value="${escapeHtml(draft(`n-tags:${n.id}`, n.tags.join(", ")))}" placeholder="${escapeHtml(t("ui.board.noteTags"))}" /><div class="actions right"><button class="btn small ghost n-cancel" type="button">${escapeHtml(t("ui.board.cancel"))}</button><button class="btn small primary n-save" type="button">${escapeHtml(t("ui.board.save"))}</button></div>`;
      const forget = () => ["n-title", "n-text", "n-tags"].forEach((f) => drafts.delete(`${f}:${n.id}`));
      card.querySelector(".n-cancel").onclick = () => { editing.delete(n.id); forget(); renderNotes(); };
      card.querySelector(".n-save").onclick = async () => { if (await call("PUT", `${API()}/notes/${n.id}`, { title: card.querySelector(".n-title").value, text: card.querySelector(".n-text").value, tags: card.querySelector(".n-tags").value.split(",") })) { editing.delete(n.id); forget(); renderNotes(); } };
      return card;
    }
    card.innerHTML = `<div class="note-head">${avatar}<div class="task-main"><div class="task-title"><b>#${n.id}</b> ${escapeHtml(n.title)}</div><div class="task-meta"><span class="mchip who">${escapeHtml(n.byName)}</span><span class="mchip">${when(n.ts)}</span>${n.tags.map((x) => `<span class="mchip tagc">${escapeHtml(x)}</span>`).join("")}</div></div></div>
      <div class="note-text${isOpen ? "" : " clamp"}">${md(n.text)}</div>
      <div class="note-actions"${isOpen ? "" : " hidden"}><button class="btn small ghost n-edit" type="button">${escapeHtml(t("ui.board.edit"))}</button><button class="btn small danger n-del" type="button">${escapeHtml(t("ui.board.delete"))}</button></div>`;
    card.querySelector(".note-head").onclick = card.querySelector(".note-text").onclick = () => { isOpen ? open.delete(key) : open.add(key); renderNotes(); };
    card.querySelector(".n-edit").onclick = () => { editing.add(n.id); renderNotes(); };
    const del = card.querySelector(".n-del");
    del.onclick = () => { if (del.dataset.armed) call("DELETE", `${API()}/notes/${n.id}`); else { del.dataset.armed = "1"; del.textContent = t("ui.board.deleteConfirm"); setTimeout(() => { delete del.dataset.armed; del.textContent = t("ui.board.delete"); }, 3000); } };
    return card;
  }

  // ---------- wiring ----------
  $("btnBoard").onclick = show;
  $("boardClose").onclick = hide;
  document.querySelectorAll("#boardTabs button").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); }));
  $("taskOwnerFilter").onchange = (ev) => { ownerFilter = ev.target.value; renderTasks(); };
  $("taskShowDone").onchange = (ev) => { showDone = ev.target.checked; renderTasks(); };
  $("noteAuthorFilter").onchange = (ev) => { noteFilter = ev.target.value; renderNotes(); };
  $("ideaDiscover").onclick = async () => { if (await call("POST", `${API()}/discover`)) toast(t("ui.board.discoverStarted")); };
  $("ideaShowAll").onchange = (ev) => { ideaShowAll = ev.target.checked; renderIdeas(); };
  $("newIdeaForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const title = $("newIdeaTitle").value.trim();
    if (!title) return;
    if (await call("POST", `${API()}/ideas`, { title, text: $("newIdeaText").value })) { $("newIdeaTitle").value = ""; $("newIdeaText").value = ""; }
  };
  $("newTaskForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const title = $("newTaskTitle").value.trim(), owner = $("newTaskOwner").value;
    if (!title || !owner) return;
    if (await call("POST", `${API()}/tasks`, { title, detail: $("newTaskDetail").value, owner, review: $("newTaskReview").checked })) { $("newTaskTitle").value = ""; $("newTaskDetail").value = ""; }
  };
  $("newNoteForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const title = $("newNoteTitle").value.trim(), text = $("newNoteText").value.trim();
    if (!title || !text) return;
    if (await call("POST", `${API()}/notes`, { title, text, tags: $("newNoteTags").value.split(",") })) { $("newNoteTitle").value = ""; $("newNoteText").value = ""; $("newNoteTags").value = ""; }
  };
  // Escape closes the innermost thing first: the mode question, then the task drawer, then the board
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || $("boardModal").hidden) return;
    if (modeCtl.confirming) cancelMode(); else if (drawerId != null) { drawerId = null; renderTasks(); } else hide();
  });

  setInterval(() => refresh(undefined, "status"), 30e3); // "stalled" depends on the clock

  return { refresh, show };
})();
