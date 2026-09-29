// Settings (⚙): one modal for what used to sit around the header. Tabs: General (language, notifications, sickness),
// Offices (the office manager of app.js), This office (work mode, round budget, spending caps), Sessions (config.json
// switches that decide cost and speed), Server (read-only facts, Codex CLI, shutting the office down).
// /?settings=<tab> opens it on that tab. Loaded after board.js and costs.js.
const settingsUI = (() => {
  const TABS = ["general", "offices", "office", "sessions", "models", "server"];
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
    loadProviders(true);
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
    else if (tab === "models") renderModels();
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
    const s = data.server;
    const rows = [
      [t("ui.settings.version"), escapeHtml(s.version ? `pixel-office ${s.version}` : "—")],
      [t("ui.settings.mode"), escapeHtml(t(s.mode === "project" ? "ui.settings.modeProject" : "ui.settings.modeGlobal"))],
      [t("ui.settings.root"), `<code>${escapeHtml(s.root)}</code>`],
      [t("ui.settings.configFile"), `<code>${escapeHtml(s.configFile)}</code>`],
      [t("ui.settings.dataDir"), `<code>${escapeHtml(s.dataDir)}</code>`],
      [t("ui.settings.port"), `<code>${escapeHtml(s.port)}</code>`],
      [t("ui.settings.host"), `<code>${escapeHtml(s.host)}</code>`],
      [t("ui.settings.node"), escapeHtml(s.node)],
    ];
    host.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join("");
  }
  // ---------- Models: the engines (Claude, Codex, Gemini, OpenRouter), what is installed and connected ----------
  let prov = null, provError = "";
  const busy = new Set(); // "<id>:<action>" running now
  async function loadProviders(fresh = false) {
    try { prov = await api("GET", "/api/providers" + (fresh ? "?fresh=1" : "")); provError = ""; syncModels(prov); }
    catch (err) { provError = err.message; }
    if (open() && tab === "models") renderModels();
  }
  // the model pickers (hire, profile) read PO.extraModels: keep it as the server has it after every change
  function syncModels(r) { if (r?.extraModels) PO.extraModels = r.extraModels; }
  function stateText(p) {
    if (!p.installed && p.canInstall) return escapeHtml(t("ui.settings.models.state.missing"));
    const [code, ...rest] = String(p.detail || "").split(":");
    const known = ["missing", "signedOut", "needKey", "badKey", "authExpired", "offline", "error"];
    if (known.includes(code)) return escapeHtml(t(`ui.settings.models.state.${code}`, { detail: rest.join(":") }));
    if (code.startsWith("http")) return escapeHtml(t("ui.settings.models.state.error", { detail: p.detail }));
    return escapeHtml(p.detail || "");
  }
  function renderModels() {
    const host = $("provList");
    if (!prov) { host.innerHTML = `<div class="muted">${escapeHtml(provError ? t("ui.settings.unavailable", { message: provError }) : t("ui.settings.loading"))}</div>`; if (!provError && !busy.size) loadProviders(); return; }
    if (host.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return; // typing: do not redraw under the cursor
    const BRAND = { claude: "#d97757", codex: "#10a37f", gemini: "#4f8ff7", openrouter: "#a78bfa" };
    const PKG = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", gemini: "@google/gemini-cli" };
    host.innerHTML = prov.providers.map((p) => {
      const b = (a) => busy.has(`${p.id}:${a}`);
      const badge = !p.installed && p.canInstall ? ["off", "notInstalled"] : !p.enabled ? ["off", "off"] : p.connected ? ["ok", "connected"] : ["warn", "notConnected"];
      const actions = [];
      if (!p.installed && p.canInstall) actions.push(`<button class="btn small primary" data-act="install" ${b("install") ? "disabled" : ""}>${escapeHtml(t(b("install") ? "ui.settings.models.installing" : "ui.settings.models.install"))}</button>`);
      else if (!p.connected && p.canLogin) actions.push(`<button class="btn small primary" data-act="login">${escapeHtml(t("ui.settings.models.login"))}</button>`);
      actions.push(`<button class="btn small ghost" data-act="check" ${b("check") ? "disabled" : ""}>${escapeHtml(t(b("check") ? "ui.settings.models.checking" : "ui.settings.models.check"))}</button>`);
      const keyRow = p.id === "gemini" || p.id === "openrouter" ? `<div class="prov-key"><label><span>${escapeHtml(t("ui.settings.models.key"))}</span><input type="password" autocomplete="off" data-key-input placeholder="${escapeHtml(t("ui.settings.models.keyPh"))}" /></label>
          <button class="btn small primary" data-act="saveKey">${escapeHtml(t("ui.settings.models.keySave"))}</button>${p.keyHint && p.keyHint !== "env" ? `<button class="btn small ghost" data-act="removeKey">${escapeHtml(t("ui.settings.models.keyRemove"))}</button>` : ""}
          ${p.keyHint ? `<small class="muted">${escapeHtml(t("ui.settings.models.keyFrom", { hint: p.keyHint === "env" ? t("ui.settings.models.keyEnv") : p.keyHint }))}</small>` : ""}</div>` : "";
      const customRow = p.id === "gemini" || p.id === "openrouter" ? `<div class="prov-key"><label><span>${escapeHtml(t("ui.settings.models.custom"))}</span><input type="text" data-custom-input value="${escapeHtml((p.custom || []).join(", "))}" /></label>
          <button class="btn small ghost" data-act="saveModels">${escapeHtml(t("ui.settings.models.customSave"))}</button></div>` : "";
      const chips = p.models.length ? p.models.map((m) => `<span class="chip" title="${escapeHtml(MODEL_INFO[m.id]?.desc || m.desc || m.id)}">${escapeHtml(m.name)}</span>`).join("") : `<small class="muted">${escapeHtml(t("ui.settings.models.noModels"))}</small>`;
      const stateLine = stateText(p);
      return `<div class="prov-card prov-${badge[0]}" data-id="${p.id}" style="--brand:${BRAND[p.id]}">
        <div class="prov-top">
          <span class="prov-mark" aria-hidden="true"><i style="--logo:url(/logos/${p.id}.svg)"></i></span>
          <div class="prov-title">
            <div class="prov-name"><b>${escapeHtml(t(`ui.settings.models.p.${p.id}.name`))}</b><span class="prov-pill"><i></i>${escapeHtml(t(`ui.settings.models.${badge[1]}`))}</span>${p.version ? `<small class="muted">${escapeHtml(t("ui.settings.models.version", { v: p.version }))}</small>` : ""}</div>
            <small class="muted">${escapeHtml(t(`ui.settings.models.p.${p.id}.desc`))}</small>
          </div>
          <label class="check prov-on" title="${escapeHtml(t("ui.settings.models.on"))}"><input type="checkbox" data-act="toggle" ${p.enabled ? "checked" : ""} /> <span>${escapeHtml(t("ui.settings.models.on"))}</span></label>
        </div>
        ${stateLine ? `<div class="prov-state">${stateLine}</div>` : ""}
        ${p.warning ? `<div class="prov-note">⚠ ${escapeHtml(t("ui.settings.models.warn", { detail: p.warning.replace(/^invalidConfig:/, "") }))}</div>` : ""}
        ${!p.installed && p.canInstall ? `<small class="muted prov-hint">${t("ui.settings.models.installHint", { pkg: PKG[p.id] })}</small>` : ""}
        ${keyRow}${customRow}
        <div class="prov-actions">${actions.join("")}</div>
        <details class="prov-models"><summary>${escapeHtml(t("ui.settings.models.modelsTitle", { n: p.models.length }))}</summary><div class="prov-chips">${chips}</div></details>
      </div>`;
    }).join("");
  }
  $("provList").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn || btn.type === "checkbox") return;
    const card = btn.closest(".prov-card"), id = card.dataset.id, act = btn.dataset.act;
    const run = async (name, fn) => {
      busy.add(`${id}:${name}`); renderModels();
      try { await fn(); } catch (err) { toast(err.message); }
      busy.delete(`${id}:${name}`);
      if (open() && tab === "models") renderModels();
    };
    if (act === "install") await run("install", async () => {
      const r = await api("POST", `/api/providers/${id}/install`);
      prov = r; syncModels(r);
      toast(r.ok ? t("ui.settings.models.installed") : t("ui.settings.models.installFailed", { output: String(r.output || "").split("\n").slice(-3).join(" ").slice(0, 300) }));
    });
    else if (act === "login") { const r = await api("POST", `/api/providers/${id}/login`).catch(() => ({ ok: false })); toast(t(r.ok ? "ui.settings.models.loginStarted" : "ui.settings.models.loginFailed")); }
    else if (act === "check") await run("check", async () => { prov = await api("POST", `/api/providers/${id}/check`); syncModels(prov); });
    else if (act === "saveKey" || act === "removeKey") await run("key", async () => {
      const v = act === "removeKey" ? "" : card.querySelector("[data-key-input]").value.trim();
      if (act === "saveKey" && !v) return;
      prov = await api("PUT", `/api/providers/${id}`, { apiKey: v }); syncModels(prov); toast(t("ui.settings.saved"));
    });
    else if (act === "saveModels") await run("models", async () => {
      const list = card.querySelector("[data-custom-input]").value.split(",").map((x) => x.trim()).filter(Boolean);
      prov = await api("PUT", `/api/providers/${id}`, { models: list }); syncModels(prov); toast(t("ui.settings.saved"));
    });
  });
  $("provList").addEventListener("change", async (ev) => {
    const el = ev.target.closest('[data-act="toggle"]');
    if (!el) return;
    const id = el.closest(".prov-card").dataset.id;
    try { prov = await api("PUT", `/api/providers/${id}`, { enabled: el.checked }); syncModels(prov); toast(t("ui.settings.saved")); }
    catch (err) { toast(err.message); }
    renderModels();
  });
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
