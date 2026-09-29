// Header strip chips (office mode, spend today, plan limits) and the costs modal (💲): today vs the daily cap, the cap
// settings, the last 7 days, and who / which task / what kind of work the money went to. Plain HTTP reads only.
const costsUI = (() => {
  const modal = wireModal("costsModal", "costsClose");
  const MODE_ICON = { manual: "✋", cycle: "🔁", auto: "🤖" };
  const failed = new Set();   // offices whose server has no /costs yet
  let quotaAsked = false, report = null, reportOffice = null, refetch = 0;
  const loading = new Set();

  // ---------- strip ----------
  function renderMode() {
    const b = cur()?.board, el = $("stripMode");
    el.hidden = !b;
    if (!b) return;
    const mode = b.mode || "manual";
    el.textContent = `${MODE_ICON[mode] || ""} ${t(`ui.board.modes.${mode}`)}`;
    el.classList.toggle("on", mode !== "manual");
  }

  const capInfo = (c) => {
    const cap = c?.cap || {};
    const daily = Number(cap.daily) || 0;
    const pct = daily ? (Number(c.today) || 0) / daily : 0;
    return { daily, pct, reached: !!cap.reached, reason: cap.reason };
  };
  function renderSpend() {
    const o = cur(), el = $("stripSpend");
    const c = o?.costs;
    el.hidden = !c;
    if (!c) return;
    const { daily, pct, reached } = capInfo(c);
    el.className = "strip-chip" + (reached ? " stop" : pct >= 0.8 ? " warn" : "");
    el.innerHTML = `${escapeHtml(usd(c.today))}${daily ? `<span class="dim"> / ${escapeHtml(usd(daily))}</span>` : ""} <span class="lbl">${escapeHtml(t(reached ? "ui.strip.stopped" : "ui.strip.today"))}</span>`;
    const codex = c.todayTokens?.codex;
    el.title = [t("ui.strip.spendTip"), codex ? t("ui.strip.codexToday", { tokens: fmtTokens(codex) }) : "", reached ? t("ui.strip.capReached") : ""].filter(Boolean).join("\n");
  }

  const when = (ts) => (ts ? new Date(ts).toLocaleString(LOCALE_TAG, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const level = (p) => (p >= 90 ? "bad" : p >= 70 ? "warn" : "");
  // one tiny bar for the window that runs out first (5 hours), plain numbers for the rest: the header stays short
  const bar = (label, w, withBar = false) => {
    const p = Math.max(0, Math.min(100, Math.round(Number(w.pct) || 0)));
    return `<span class="q ${level(p)}"><span class="lbl">${escapeHtml(label)}</span>${withBar ? `<i class="qbar"><i style="width:${p}%"></i></i>` : ""}${p}%</span>`;
  };
  function renderQuota() {
    const q = state.quota, el = $("stripQuota");
    const parts = [], tips = [];
    const tip = (name, w) => tips.push(w.resetsAt ? t("ui.strip.quotaTip", { name, pct: Math.round(w.pct || 0), when: when(w.resetsAt) }) : t("ui.strip.quotaTipNoReset", { name, pct: Math.round(w.pct || 0) }));
    if (q?.claude?.fiveHour) { parts.push(bar(t("ui.strip.q5h"), q.claude.fiveHour, true)); tip(t("ui.strip.qClaude5h"), q.claude.fiveHour); }
    if (q?.claude?.week) { parts.push(bar(t("ui.strip.qWeek"), q.claude.week)); tip(t("ui.strip.qClaudeWeek"), q.claude.week); }
    if (q?.codex?.primary) { parts.push(bar(t("ui.strip.qCodex"), q.codex.primary)); tip(t("ui.strip.qCodexName"), q.codex.primary); }
    if (q?.codex?.secondary) tip(t("ui.strip.qCodexWeek"), q.codex.secondary);
    el.hidden = !parts.length;
    el.innerHTML = parts.join("");
    el.title = tips.join("\n");
  }

  async function loadToday(officeId = state.office) {
    if (failed.has(officeId) || loading.has(officeId)) return;
    loading.add(officeId);
    try {
      const r = await api("GET", `/api/offices/${encodeURIComponent(officeId)}/costs?days=7`);
      const o = state.offices.get(officeId);
      if (o) o.costs = { today: r.today, todayTokens: r.todayTokens, cap: r.cap };
      if (officeId === state.office) { report = r; reportOffice = officeId; renderSpend(); if (modal.open) render(); if (window.statusUI?.list) renderRoster(); }
    } catch { failed.add(officeId); if (officeId === state.office) { renderSpend(); if (modal.open) render(); } }
    loading.delete(officeId);
  }
  async function loadQuota() {
    quotaAsked = true;
    try { state.quota = await api("GET", "/api/quota"); } catch { state.quota = null; }
    renderQuota();
  }

  // ---------- modal ----------
  function render() {
    const host = $("costsBody");
    const r = reportOffice === state.office ? report : null;
    if (!r) { host.innerHTML = `<div class="muted panel-empty">${escapeHtml(t(failed.has(state.office) ? "ui.costs.unavailable" : "ui.activity.loading"))}</div>`; return; }
    const { daily, pct, reached, reason } = capInfo(r);
    const codexCap = Number(r.cap?.codexTokens) || 0;
    const codexToday = Number(r.todayTokens?.codex) || 0;
    const fill = (p, cls = "") => `<div class="cbar ${cls}"><i style="width:${Math.min(100, Math.round(p * 100))}%"></i></div>`;
    const max = Math.max(0.01, ...(r.days || []).map((d) => d.cost || 0));
    const days = (r.days || []).map((d) => {
      const lbl = new Date(d.day + "T12:00").toLocaleDateString(LOCALE_TAG, { weekday: "short" });
      const tip = `${d.day} · ${usd(d.cost)}${d.codexTokens ? ` · Codex ${fmtTokens(d.codexTokens)}` : ""}`;
      return `<div class="cday" title="${escapeHtml(tip)}"><small>${d.cost >= 0.01 ? escapeHtml(usd(d.cost)) : ""}</small><div class="ccol"><i style="height:${Math.round(((d.cost || 0) / max) * 100)}%"></i></div><span>${escapeHtml(lbl)}</span></div>`;
    }).join("");
    const emps = (r.byEmployee || []).slice().sort((a, b) => b.period - a.period);
    const empRows = emps.map((e) => `<tr><td><i class="dot" style="background:${escapeHtml(cur()?.employees.get(e.emp)?.color || "var(--idle)")}"></i> ${escapeHtml(e.emp === "_meeting" ? t("ui.costs.meetingSummary") : e.name || e.emp)}</td><td>${usd(e.today)}</td><td>${usd(e.period)}</td><td class="muted">${e.codexTokens ? fmtTokens(e.codexTokens) : ""}</td></tr>`).join("");
    const taskRows = (r.byTask || []).map((k) => `<tr class="link" data-task="${k.task}"><td><b class="acc">#${k.task}</b> ${escapeHtml(k.title || "")}</td><td>${usd(k.cost)}</td><td class="muted">${k.codexTokens ? fmtTokens(k.codexTokens) : ""}</td></tr>`).join("");
    const kinds = Object.entries(r.byKind || {}).filter(([, v]) => v > 0).map(([k, v]) => `<span class="chip">${escapeHtml(t(`ui.costs.kind.${k}`))} ${usd(v)}</span>`).join("");
    host.innerHTML = `
      <div class="ctoday">
        <div class="ctop"><b>${usd(r.today)}</b> <span class="muted">${escapeHtml(daily ? t("ui.costs.todayOf", { cap: usd(daily) }) : t("ui.costs.todayNoCap"))}</span>${reached ? ` <span class="tag alert">${escapeHtml(t("ui.costs.stopped"))}</span>` : ""}</div>
        ${daily ? fill(pct, reached ? "bad" : pct >= 0.8 ? "warn" : "") : ""}
        ${codexToday || codexCap ? `<div class="ctop small"><span class="muted">Codex</span> <b>${fmtTokens(codexToday)}</b> <span class="muted">${escapeHtml(codexCap ? t("ui.costs.tokensOf", { cap: fmtTokens(codexCap) }) : t("ui.costs.tokens"))}</span></div>${codexCap ? fill(codexToday / codexCap) : ""}` : ""}
        ${reached ? `<small class="muted">${escapeHtml(t("ui.costs.stoppedHint"))}${reason ? ` (${escapeHtml(t(`ui.activity.capWhat.${reason === "codex" ? "codex" : "daily"}`))})` : ""}</small>` : ""}
      </div>
      <form class="ccap" id="capForm">
        <label><span>${escapeHtml(t("ui.costs.capDaily"))}</span><input id="capDaily" type="number" min="0" step="any" value="${daily || 0}" /></label>
        <label><span>${escapeHtml(t("ui.costs.capCodex"))}</span><input id="capCodex" type="number" min="0" step="any" value="${codexCap || 0}" /></label>
        <button class="btn small primary" type="submit">${escapeHtml(t("ui.costs.save"))}</button>
        <small class="muted">${escapeHtml(t("ui.costs.capHint"))}</small>
      </form>
      <h3>${escapeHtml(t("ui.costs.last7"))}</h3>
      <div class="cchart">${days}</div>
      ${kinds ? `<div class="ckinds">${kinds}</div>` : ""}
      <h3>${escapeHtml(t("ui.costs.byEmployee"))}</h3>
      ${empRows ? `<table class="ctable"><thead><tr><th></th><th>${escapeHtml(t("ui.costs.today"))}</th><th>${escapeHtml(t("ui.costs.days", { n: (r.days || []).length || 7 }))}</th><th>Codex</th></tr></thead><tbody>${empRows}</tbody></table>` : `<div class="muted">${escapeHtml(t("ui.costs.none"))}</div>`}
      <h3>${escapeHtml(t("ui.costs.byTask"))}</h3>
      ${taskRows ? `<table class="ctable"><tbody>${taskRows}</tbody></table>` : `<div class="muted">${escapeHtml(t("ui.costs.none"))}</div>`}
      <p class="muted cnote">${escapeHtml(t("ui.costs.codexNote"))}</p>`;
    host.querySelectorAll("tr[data-task]").forEach((tr) => (tr.onclick = () => { modal.hide(); openTask(Number(tr.dataset.task)); }));
    $("capForm").onsubmit = async (ev) => {
      ev.preventDefault();
      if (await saveCap($("capDaily").value, $("capCodex").value)) render();
    };
  }
  // The daily $ cap and the Codex token cap of the current office; Settings → This office saves through here too.
  async function saveCap(daily, codexTokens) {
    try {
      report = await api("PUT", officeApi("/costs/cap"), { daily: Math.max(0, Number(daily) || 0), codexTokens: Math.max(0, Math.round(Number(codexTokens) || 0)) });
      reportOffice = state.office;
      cur().costs = { today: report.today, todayTokens: report.todayTokens, cap: report.cap };
      toast(t("ui.costs.saved"));
      renderSpend();
      return true;
    } catch (err) { toast(err.message); return false; }
  }

  function show() { modal.show(); render(); loadToday(); }
  $("stripSpend").onclick = show;
  $("stripQuota").onclick = show;
  $("stripMode").onclick = () => boardUI.show();

  panelHooks.push((what, officeId) => {
    if (what === "quota") { renderQuota(); return; }
    if (officeId && officeId !== state.office) return;
    if (what === "office") {
      if (reportOffice !== state.office) report = null;
      renderMode(); renderSpend(); renderQuota();
      if (!cur()?.costs) loadToday();
      if (!quotaAsked && state.quota === undefined) loadQuota();
      return;
    }
    if (what === "board") renderMode();
    if (what === "costs") {
      renderSpend();
      // the open modal follows along, one read every few seconds at most
      if ((modal.open || window.statusUI?.list) && !refetch) refetch = setTimeout(() => { refetch = 0; loadToday(); }, 3000);
    }
  });
  // the status list shows today's spend per employee: read the report once when it is first needed
  const ensureReport = () => { if (reportOffice !== state.office) loadToday(); };
  return { show, ensureReport, saveCap, report: () => (reportOffice === state.office ? report : null) };
})();
