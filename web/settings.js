// Settings (⚙): one modal for what used to sit around the header. Tabs: General (language, notifications, sickness),
// Offices (the office manager of app.js), This office (work mode, round budget, spending caps), Sessions (config.json
// switches that decide cost and speed), Server (read-only facts, Codex CLI, shutting the office down).
// /?settings=<tab> opens it on that tab. Loaded after board.js and costs.js.
const settingsUI = (() => {
  const TABS = ["general", "offices", "office", "sessions", "server"];
  const modal = $("settingsModal");
  let tab = "general", data = null, loadError = "";
  const open = () => !modal.hidden;

  // the work-mode row of the board, a second copy of it here (board.js makeModeControl)
  const modeCtl = makeModeControl({ root: $("setMode"), mode: $("setOfficeMode"), budget: $("setOfficeBudget"), rounds: $("setOfficeRounds"), hint: $("setOfficeModeHint"), phase: $("setCyclePhase"), confirm: $("setModeConfirm") }, () => open() && tab === "office");

  function show(which) {
    if (TABS.includes(which)) tab = which;
    modal.hidden = false;
    render();
    load();
  }
  // a number typed but not yet confirmed (no Enter, no click elsewhere) is saved when the tab or the modal closes
  const commit = () => { const a = document.activeElement; if (a?.dataset?.key && modal.contains(a)) a.blur(); };
  function hide() { if (!open()) return; commit(); modal.hidden = true; modeCtl.cancel(); }

  async function load() {
    try { data = await api("GET", "/api/settings"); loadError = ""; }
    catch (err) { loadError = err.message; }
    if (open()) render();
  }

  function render() {
    document.querySelectorAll("#settingsTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    modal.querySelectorAll(".set-pane").forEach((p) => (p.hidden = p.dataset.pane !== tab));
    if (tab === "general") renderGeneral();
    else if (tab === "offices") renderOfficeList();
    else if (tab === "office") renderOffice();
    else if (tab === "sessions") renderSessions();
    else renderServer();
  }

  // ---------- General ----------
  function renderGeneral() {
    const n = $("setNotify");
    n.checked = notifyOn();
    n.disabled = !("Notification" in window);
    $("setNotifyHint").textContent = t(n.disabled ? "ui.settings.notifyNone" : "ui.settings.notifyHint");
    fillSwitches();
  }
  $("setNotify").onchange = async (ev) => { ev.target.disabled = true; ev.target.checked = await setNotify(ev.target.checked); ev.target.disabled = false; };

  // ---------- config.json switches (General's sickness + Sessions) ----------
  // Shown as the server has them; each change is saved on its own and applied live by the server.
  function fillSwitches(force = false) {
    const pending = !data;
    modal.querySelectorAll("[data-key]").forEach((el) => {
      const k = el.dataset.key, locked = !!data?.envLocked?.[k];
      el.disabled = pending || locked;
      if (pending || (document.activeElement === el && !force)) return;
      if (el.type === "checkbox") el.checked = !!data[k];
      else el.value = k === "compactAtTokens" ? Math.round((data[k] || 0) / 1000) : data[k];
    });
    modal.querySelectorAll("[data-lock]").forEach((el) => {
      const k = el.dataset.lock, locked = !!data?.envLocked?.[k];
      el.hidden = !locked;
      if (locked) el.textContent = t("ui.settings.envLocked", { name: k === "sickness" ? "PIXEL_OFFICE_SICKNESS" : "PIXEL_OFFICE_COMPACT_AT" });
    });
  }
  async function saveSwitch(el) {
    const k = el.dataset.key;
    const value = el.type === "checkbox" ? el.checked : k === "compactAtTokens" ? Math.round(Number(el.value) || 0) * 1000 : Number(el.value);
    el.disabled = true;
    try { data = await api("PUT", "/api/settings", { [k]: value }); toast(t("ui.settings.saved")); }
    catch (err) { toast(err.message); }
    el.disabled = false;
    fillSwitches(true); // what the server kept (a refused value goes back to the saved one)
  }
  modal.querySelectorAll("[data-key]").forEach((el) => (el.onchange = () => saveSwitch(el)));

  function renderSessions() { fillSwitches(); }

  // ---------- This office ----------
  function renderOffice() {
    const o = cur();
    $("setOfficeName").textContent = o ? t("ui.settings.officeOf", { name: o.info.name || t("ui.offices.default") }) : "";
    modeCtl.render();
    const cap = o?.costs?.cap;
    if (cap) fillCap(cap);
    else if (o) api("GET", officeApi("/costs?days=1")).then((r) => { if (cur() === o && open() && tab === "office") fillCap(r.cap); }).catch(() => {});
  }
  function fillCap(cap) {
    for (const [id, v] of [["setCapDaily", cap?.daily], ["setCapCodex", cap?.codexTokens]]) if (document.activeElement !== $(id)) $(id).value = Number(v) || 0;
  }
  $("setCapForm").onsubmit = async (ev) => {
    ev.preventDefault();
    if (await costsUI.saveCap($("setCapDaily").value, $("setCapCodex").value)) renderOffice();
  };
  $("setCostsLink").onclick = () => { hide(); costsUI.show(); };

  // ---------- Server ----------
  function renderServer() {
    const host = $("setServerInfo");
    if (!data) { host.innerHTML = `<div class="muted">${escapeHtml(loadError ? t("ui.settings.unavailable", { message: loadError }) : t("ui.settings.loading"))}</div>`; return; }
    const s = data.server, c = data.codex;
    const codex = !c.installed ? escapeHtml(t("ui.settings.codexMissing"))
      : c.loggedIn ? escapeHtml(t("ui.settings.codexIn", { version: c.version, n: c.models })) : t("ui.settings.codexOut", { version: escapeHtml(c.version) });
    const rows = [
      [t("ui.settings.version"), escapeHtml(s.version ? `pixel-office ${s.version}` : "—")],
      [t("ui.settings.mode"), escapeHtml(t(s.mode === "project" ? "ui.settings.modeProject" : "ui.settings.modeGlobal"))],
      [t("ui.settings.root"), `<code>${escapeHtml(s.root)}</code>`],
      [t("ui.settings.configFile"), `<code>${escapeHtml(s.configFile)}</code>`],
      [t("ui.settings.dataDir"), `<code>${escapeHtml(s.dataDir)}</code>`],
      [t("ui.settings.port"), `<code>${escapeHtml(s.port)}</code>`],
      [t("ui.settings.host"), `<code>${escapeHtml(s.host)}</code>`],
      [t("ui.settings.node"), escapeHtml(s.node)],
      [t("ui.settings.codex"), `<span class="${c.installed && c.loggedIn ? "" : "muted"}">${codex}</span>`],
    ];
    host.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join("");
  }
  $("setShutdown").onclick = () => askShutdown();

  // ---------- wiring ----------
  $("btnSettings").onclick = () => show();
  $("settingsClose").onclick = hide;
  modal.addEventListener("click", (ev) => { if (ev.target === modal) hide(); });
  document.querySelectorAll("#settingsTabs button").forEach((b) => (b.onclick = () => { commit(); if (tab === "office") modeCtl.cancel(); tab = b.dataset.tab; render(); }));
  // Escape: the mode question first, then the modal (the shutdown card above it closes itself in app.js)
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !open()) return;
    if (modeCtl.confirming) modeCtl.cancel(); else hide();
  });
  // the office tab follows the office shown, its board (mode) and its costs (cap)
  let shownOffice = null;
  panelHooks.push((what, officeId) => {
    if (!open() || tab !== "office" || (officeId && officeId !== state.office)) return;
    if (what === "office" && shownOffice !== state.office) { shownOffice = state.office; modeCtl.cancel(); } // another office: its own question
    if (what === "office" || what === "board" || what === "costs") renderOffice();
  });

  const deep = params.get("settings");
  if (deep != null) show(deep);
  return { show, hide };
})();
