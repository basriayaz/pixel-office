// First-task guide: a short card with an arrow to the real element, moving on when the real state is reached
// (provider connected, chat message sent, answer arrived). It never sends anything itself. Loaded last.
const guideUI = (() => {
  const KEY = "po.guide";
  const ORDER = ["pick", "provider", "folder", "draft", "work", "result", "cost"];
  const card = document.createElement("div");
  card.className = "guide-card"; card.hidden = true;
  card.setAttribute("role", "dialog"); card.setAttribute("aria-labelledby", "guideTitle"); card.setAttribute("aria-live", "polite");
  const ring = document.createElement("div");
  ring.className = "guide-ring"; ring.hidden = true; ring.setAttribute("aria-hidden", "true");
  document.body.append(ring, card);

  let active = false, step = 0, enteredAt = 0, sentAt = 0, prov = null, provAt = 0, timer = 0, sig = "", note = "";
  const sel = () => (state.selected ? cur()?.employees.get(state.selected) : null);
  const provOf = (e) => prov?.providers?.find((p) => p.id === (e?.engine || "claude"));
  const visible = (el) => el && !el.hidden && el.getClientRects().length > 0;
  const fileRe = /[\w./~-]+\.(?:md|markdown|txt|rst|adoc)\b/i;
  const missingRe = /(bulunamad|yok\b|not found|no readme|does not exist|doesn't exist|couldn't find|could not find)/i;

  function store(v) { try { localStorage.setItem(KEY, v); } catch {} }
  function stored() { try { return localStorage.getItem(KEY); } catch { return null; } }

  async function loadProv() {
    provAt = Date.now();
    try { prov = await api("GET", "/api/providers"); } catch { prov = null; }
    render(true);
  }
  const userMsgsAfter = (e, ts) => (e?.messages || []).filter((m) => m.role === "user" && m.ts >= ts);
  const lastAnswer = (e) => [...(e?.messages || [])].reverse().find((m) => m.role === "assistant" && m.ts >= sentAt);

  function targetFor(id, e) {
    const askEl = () => document.querySelector("#chatBody [data-ask]");
    switch (id) {
      case "pick": return document.querySelector("#roster .roster-chip, #roster .srow") || $("office");
      case "provider": return $("settingsModal").hidden ? $("btnSettings") : $("provList");
      case "folder": return $("settingsModal").hidden ? $("chatModel") : $("officeList");
      case "draft": return $("chatInput").value.trim() ? $("btnSend") : $("chatInput");
      case "work": return e?.pending?.length ? askEl() : $("chatStatus");
      case "result": return [...document.querySelectorAll("#chatBody .row.assistant .bubble")].pop() || $("chatBody");
      case "cost": return visible($("stripSpend")) ? $("stripSpend") : $("btnSettings");
    }
  }

  // which step the real state calls for; steps only move forward
  function advance() {
    const e = sel();
    for (let guard = 0; guard < 8; guard++) {
      const id = ORDER[step];
      let done = false;
      if (id === "pick") done = !!e;
      else if (id === "provider") { const p = provOf(e); done = !!(e && p?.connected && p.enabled); if (done) note = t("ui.guide.provOk", { model: modelName(e.model) || "—", name: e.name }); }
      else if (id === "draft") { const m = userMsgsAfter(e, enteredAt)[0]; done = !!m; if (done) sentAt = m.ts; }
      else if (id === "work") done = !!(e && lastAnswer(e) && !e.pending?.length && e.status !== "working" && e.status !== "waiting");
      if (!done) return;
      goto(step + 1);
    }
  }
  function goto(i) { step = Math.min(i, ORDER.length - 1); enteredAt = Date.now(); sig = ""; if (ORDER[step] === "provider" && !prov) loadProv(); }

  const btn = (label, cls, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn small " + cls; b.textContent = label; b.onclick = fn; return b; };

  function body(id, e) {
    const p = provOf(e), text = [], acts = [];
    const engine = e?.engine || "claude";
    if (id === "pick") text.push(t("ui.guide.pick"));
    if (id === "provider") {
      text.push(t("ui.guide.provider", { name: e?.name || "", model: modelName(e?.model) || "—", provider: p?.name || engine }));
      text.push(!prov ? t("ui.guide.provLoading") : p ? t(p.connected ? "ui.guide.provDisabled" : "ui.guide.provNo", { provider: p.name || engine }) : t("ui.guide.provUnknown"));
      acts.push(btn(t("ui.guide.openModels"), "primary", () => settingsUI.show("models")), btn(t("ui.guide.recheck"), "ghost", loadProv));
    }
    if (id === "folder") {
      text.push(t("ui.guide.folder", { path: cur()?.info?.cwd || PO.projectDisplay || "." }));
      acts.push(btn(t("ui.guide.folderOk"), "primary", () => goto(step + 1)), btn(t("ui.guide.folderChange"), "ghost", () => settingsUI.show("offices")));
    }
    if (id === "draft") {
      text.push(t("ui.guide.draft"));
      const input = $("chatInput");
      acts.push(btn(t("ui.guide.putDraft"), "primary", () => {
        if (input.value.trim() && input.value.trim() !== t("ui.guide.draftText")) { note = t("ui.guide.boxBusy"); render(true); return; }
        input.value = t("ui.guide.draftText"); input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); note = ""; render(true);
      }));
    }
    if (id === "work") {
      if (e?.pending?.length) text.push(t("ui.guide.permission"));
      else if (e?.status === "error" || e?.status === "sick") text.push(t("ui.guide.failed"));
      else text.push(t("ui.guide.working"));
    }
    if (id === "result") {
      const a = lastAnswer(e), m = a && fileRe.exec(a.text);
      text.push(m ? t("ui.guide.source", { file: m[0] }) : t("ui.guide.noSource"));
      if (a && (!m || missingRe.test(a.text.slice(0, 400)))) {
        text.push(t("ui.guide.otherFile"));
        const row = document.createElement("div"); row.className = "guide-row";
        const inp = document.createElement("input"); inp.type = "text"; inp.placeholder = "CONTRIBUTING.md"; inp.setAttribute("aria-label", t("ui.guide.fileLabel"));
        row.append(inp, btn(t("ui.guide.putDraft"), "", () => {
          const f = inp.value.trim(); if (!f) { inp.focus(); return; }
          const box = $("chatInput"); box.value = t("ui.guide.draftFile", { file: f }); box.dispatchEvent(new Event("input", { bubbles: true })); box.focus();
          goto(ORDER.indexOf("draft")); render(true);
        }));
        acts.push(row);
      }
      acts.push(btn(t("ui.guide.next"), "primary", () => goto(step + 1)));
    }
    if (id === "cost") {
      text.push(t("ui.guide.cost"));
      if (engine === "gemini") text.push(t("ui.guide.costGemini"));
      acts.push(btn(t("ui.guide.openCosts"), "ghost", () => costsUI.show()), btn(t("ui.guide.finish"), "primary", () => finish("done")));
    }
    return { text, acts };
  }

  function render(force) {
    if (!active) return;
    const e = sel();
    advance();
    const id = ORDER[step], tgt = targetFor(id, e);
    const key = [id, e?.id, e?.status, e?.pending?.length, !!prov, provOf(e)?.connected, $("chatInput").value ? 1 : 0, $("settingsModal").hidden, note, lastAnswer(e)?.ts, visible(tgt)].join("|");
    if (force || key !== sig) {
      sig = key;
      const { text, acts } = body(id, e);
      card.innerHTML = "";
      const head = document.createElement("div"); head.className = "guide-head"; head.tabIndex = -1;
      head.innerHTML = `<span class="guide-count" aria-label="${escapeHtml(t("ui.guide.counterAria", { i: step + 1, n: ORDER.length }))}">${step + 1}/${ORDER.length}</span><b id="guideTitle">${escapeHtml(t(`ui.guide.t.${id}`))}</b>`;
      const x = btn("×", "ghost guide-x", () => finish("skipped")); x.setAttribute("aria-label", t("ui.guide.exit")); x.title = t("ui.guide.exit"); head.appendChild(x);
      const p = document.createElement("div"); p.className = "guide-text";
      p.innerHTML = (note && id !== "provider" ? `<p class="guide-note">${escapeHtml(note)}</p>` : "") + text.map((s) => `<p>${s}</p>`).join("");
      const foot = document.createElement("div"); foot.className = "guide-acts";
      foot.append(...acts);
      const skip = btn(t("ui.guide.skipStep"), "ghost guide-skip", () => goto(step + 1)); if (step < ORDER.length - 1) foot.appendChild(skip);
      const out = btn(t("ui.guide.exit"), "ghost guide-skip", () => finish("skipped")); foot.appendChild(out);
      card.append(head, p, foot);
    }
    place(tgt);
  }

  // ring around the real element, arrow on the card's side facing it; no element on screen: no ring, no arrow
  function place(tgt) {
    const narrow = window.innerWidth < 700;
    const r = visible(tgt) ? tgt.getBoundingClientRect() : null;
    ring.hidden = !r;
    card.dataset.arrow = "";
    if (r) { Object.assign(ring.style, { left: r.left - 4 + "px", top: r.top - 4 + "px", width: r.width + 8 + "px", height: r.height + 8 + "px" }); }
    const cw = card.offsetWidth, ch = card.offsetHeight, W = window.innerWidth, H = window.innerHeight;
    if (narrow || !r) { card.style.left = narrow ? "8px" : "auto"; card.style.right = narrow ? "auto" : "12px"; card.style.top = "auto"; card.style.bottom = "12px"; card.style.width = narrow ? "calc(100% - 16px)" : ""; return; }
    card.style.width = ""; card.style.bottom = "auto"; card.style.right = "auto";
    let left, top;
    if (r.bottom + ch + 24 < H) { top = r.bottom + 14; card.dataset.arrow = "up"; left = r.left + r.width / 2 - cw / 2; }
    else if (r.top - ch - 24 > 0) { top = r.top - ch - 14; card.dataset.arrow = "down"; left = r.left + r.width / 2 - cw / 2; }
    else if (r.left - cw - 24 > 0) { left = r.left - cw - 14; card.dataset.arrow = "right"; top = r.top + r.height / 2 - ch / 2; }
    else { left = W - cw - 12; top = H - ch - 12; }
    left = Math.max(8, Math.min(W - cw - 8, left)); top = Math.max(8, Math.min(H - ch - 8, top));
    card.style.left = left + "px"; card.style.top = top + "px";
    if (card.dataset.arrow === "up" || card.dataset.arrow === "down") card.style.setProperty("--ax", Math.max(14, Math.min(cw - 14, r.left + r.width / 2 - left)) + "px");
    else card.style.setProperty("--ay", Math.max(14, Math.min(ch - 14, r.top + r.height / 2 - top)) + "px");
  }

  function start() {
    if (active) return;
    active = true; step = 0; enteredAt = Date.now(); sentAt = 0; note = ""; sig = "";
    $("welcomeModal").hidden = true;
    card.hidden = false;
    prov = null; loadProv();
    render(true);
    timer = setInterval(() => { if (document.hidden) return; if (ORDER[step] === "provider" && Date.now() - provAt > 5000) loadProv(); else render(); }, 600);
    card.querySelector(".guide-head")?.focus();
  }
  function finish(how) {
    if (!active) return;
    active = false; clearInterval(timer); card.hidden = true; ring.hidden = true;
    store(how);
    if (how === "done") toast(t("ui.guide.done"));
  }

  window.addEventListener("resize", () => render());
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !active || ev.defaultPrevented) return;
    if (document.querySelector(".modal:not([hidden])") && !card.contains(document.activeElement)) return;
    finish("skipped");
  });

  $("btnGuide").onclick = () => (active ? finish("skipped") : start());
  $("welcomeGuide").onclick = () => { try { localStorage.setItem("po.welcomed", "1"); } catch {} start(); };
  if (new URLSearchParams(location.search).get("guide") === "1") start();
  return { start, finish, get active() { return active; }, get state() { return stored(); } };
})();
