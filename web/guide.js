// Guide: 8 sections, 69 short cards, each pointing at the real element. It never advances by itself, sends nothing,
// saves nothing and starts no work: it only opens panels and tabs (navigation) and can put a draft in the message box.
// Loaded last. Texts: ui.guide.* (sec.<X>.n/d for sections, s.<ID>.t/b for steps).
const guideUI = (() => {
  const KEY = "po.guide", POS = "po.guide.pos", SEEN = "po.guide.seen", ON = "po.guide.on";
  // [id, { t: target selectors (first visible wins), o: panel to open, chat: needs an open chat, c: conditional, x: extra, pg: page link }]
  const CAT = [
    ["B", [
      ["B1", { t: ["#office"] }], ["B2", { t: ["#hireLink"] }],
      ["B3", { t: ["#roster .roster-chip, #roster .srow", "#office"] }],
      ["B4", { t: ["#chat .chat-title"], chat: 1, x: "folder" }],
      ["B5", { o: "settings:models", t: ["#provList"], x: "prov" }],
      ["B6", { t: ["#chatInput"], chat: 1, x: "draft" }],
      ["B7", { t: [":lastBubble", "#stripSpend", "#btnSettings"], x: "result" }],
    ]],
    ["E", [
      ["E1", { t: ["#hireLink"], pg: "hire" }], ["E2", { t: ["#hireLink"], pg: "hire" }], ["E3", { t: ["#hireLink"], pg: "hire" }],
      ["E4", { pg: "profile" }], ["E5", { pg: "memory" }], ["E6", { pg: "memory" }], ["E7", { pg: "skills" }], ["E8", { pg: "skills" }],
      ["E9", { pg: "history" }], ["E10", { pg: "settings" }], ["E11", { pg: "settings" }], ["E12", { pg: "settings" }], ["E13", { pg: "settings" }],
    ]],
    ["C", [
      ["C1", { t: ["#chatInput"], chat: 1 }],
      ["C2", { t: ["#jumpDown", "#chatBody"], chat: 1, c: 1 }],
      ["C3", { t: ["#chatBody [data-ask]", "#chatBody"], chat: 1, c: 1 }],
      ["C4", { t: ["#chatBody .queue-meta", "#chatBody"], chat: 1, c: 1 }],
      ["C5", { t: ["#chatTask", "#chatStatus"], chat: 1, c: 1 }],
      ["C6", { t: ["#btnStop"], chat: 1 }],
      ["C7", { t: ["#btnCure", "#chatStatus"], chat: 1, c: 1 }],
      ["C8", { t: ["#ideaCtx", "#chatResize"], chat: 1, c: 1 }],
    ]],
    ["T", [
      ["T1", { o: "meetstart", t: ["#meetPick", "#btnMeeting"] }],
      ["T2", { o: "meetstart", t: ["#meetBusyField", "#meetCost"], c: 1 }],
      ["T3", { t: ["#meetForm", "#btnMeeting"], c: 1 }],
      ["T4", { t: ["#meetHands", "#btnMeeting"], c: 1 }],
      ["T5", { t: ["#meetEnd", "#btnMeeting"], c: 1 }],
      ["T6", { o: "meetstart", t: ["#meetStartHistory"] }],
    ]],
    ["P", [
      ["P1", { o: "board:tasks", t: ["#boardTabs"] }],
      ["P2", { o: "board:tasks", t: ["#boardTasks .board-new summary"] }],
      ["P3", { o: "board:tasks", t: ["#taskOwnerFilter"] }],
      ["P4", { o: "board:tasks", t: ["#taskList .task-card .task-actions", "#taskList"], c: 1 }],
      ["P5", { o: "board:tasks", t: ["#taskDrawer", "#taskList"], c: 1 }],
      ["P6", { o: "board:tasks", t: ["#taskDrawer", "#taskList"], c: 1 }],
      ["P7", { o: "board:tasks", t: ["#taskList .task-card.review", "#taskList"], c: 1 }],
      ["P8", { o: "board:ideas", t: ["#boardIdeas .board-bar"] }],
      ["P9", { o: "board:ideas", t: ["#boardIdeas .board-new summary"] }],
      ["P10", { o: "board:ideas", t: ["#ideaList"] }],
      ["P11", { o: "board:ideas", t: ["#ideaDiscover"] }],
      ["P12", { o: "board:notes", t: ["#boardNotes .board-bar"] }],
    ]],
    ["I", [
      ["I1", { o: "inbox", t: ["#inboxList"] }], ["I2", { o: "inbox", t: ["#inboxList"] }],
      ["I3", { o: "activity", t: ["#activityFilters"] }],
      ["I4", { t: ["#awayCard", "#btnActivity"], c: 1 }],
      ["I5", { t: ["#stripSpend", "#stripQuota", "#btnSettings"] }],
      ["I6", { o: "costs", t: ["#costsBody"] }],
    ]],
    ["A", [
      ["A1", { o: "settings:general", t: ["#langHost"] }],
      ["A2", { o: "settings:general", t: ["#settingsModal .field:has(#setNotify)"] }],
      ["A3", { o: "settings:general", t: ["#settingsModal .field:has(#setSickness)"] }],
      ["A4", { o: "settings:models", t: ["#provList"] }],
      ["A5", { o: "settings:models", t: ["#provList .prov-actions", "#provList"] }],
      ["A6", { o: "settings:models", t: ["#provList .prov-key", "#provList"], c: 1 }],
      ["A7", { o: "settings:models", t: ["#provList .prov-prices", "#provList"], c: 1 }],
      ["A8", { o: "settings:sessions", t: ["#settingsModal .field:has(#setCompact)"] }],
      ["A9", { o: "settings:sessions", t: ["#settingsModal .field:has(#setSync)"] }],
      ["A10", { o: "settings:server", t: ["#setServerInfo"] }],
    ]],
    ["O", [
      ["O1", { t: ["#offices", "#office"], c: 1 }],
      ["O2", { o: "settings:offices", t: ["#officeList"] }],
      ["O3", { o: "settings:offices", t: ["#officeAdd"] }],
      ["O4", { o: "settings:offices", t: ["#oTheme"] }],
      ["O5", { o: "settings:office", t: ["#setMode"] }],
      ["O6", { o: "settings:office", t: ["#setOfficeBudget", "#setMode"] }],
      ["O7", { o: "settings:office", t: ["#setCapForm"] }],
    ]],
  ];
  const SECS = CAT.map((c) => c[0]);
  const STEPS = Object.fromEntries(CAT);
  const CLOSERS = { settings: "settingsClose", board: "boardClose", costs: "costsClose", inbox: "inboxClose", activity: "activityClose", meetstart: "meetStartClose" };
  const MODALS = { settings: "settingsModal", board: "boardModal", costs: "costsModal", inbox: "inboxModal", activity: "activityModal", meetstart: "meetStartModal" };
  const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const card = document.createElement("div");
  card.className = "guide-card"; card.hidden = true;
  card.setAttribute("role", "dialog"); card.setAttribute("aria-labelledby", "guideTitle"); card.setAttribute("aria-describedby", "guideBody");
  const ring = document.createElement("div");
  ring.className = "guide-ring"; ring.hidden = true; ring.setAttribute("aria-hidden", "true");
  document.body.append(ring, card);

  let active = false, menu = true, sec = "B", idx = 0, enteredAt = 0, prov = null, provAt = 0, timer = 0, sig = "", note = "", scrolledFor = "";
  const opened = new Set();
  let docs = null, docsOffice = "";

  const store = (v) => { try { localStorage.setItem(KEY, v); } catch {} };
  const stored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const esc = (v) => escapeHtml(String(v ?? ""));
  const sel = () => (state.selected ? cur()?.employees.get(state.selected) : null);
  const chatOpen = () => document.body.classList.contains("chat-open") && !!sel();
  const provOf = (e) => prov?.providers?.find((p) => p.id === (e?.engine || "claude"));
  const lastAnswer = (e) => [...(e?.messages || [])].reverse().find((m) => m.role === "assistant");
  const userMsgsAfter = (e, ts) => (e?.messages || []).filter((m) => m.role === "user" && m.ts >= ts);
  const step = () => STEPS[sec][idx];
  const sname = (s) => t(`ui.guide.sec.${s}.n`);

  // shown = really on screen: not hidden, inside the viewport, and not covered by a backdrop
  function shown(el) {
    if (!el || el.hidden) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + Math.min(r.height / 2, 24))));
    return !!hit && (el.contains(hit) || hit.contains(el) || card.contains(hit));
  }
  function pick(list) {
    for (const s of list) {
      let el = null;
      if (s === ":lastBubble") el = [...document.querySelectorAll("#chatBody .row.assistant .bubble")].pop();
      else { try { el = document.querySelector(s); } catch {} }
      if (shown(el)) return el;
    }
    return null;
  }

  async function loadDocs() {
    const id = state.office; if (!id || docsOffice === id) return;
    docsOffice = id; docs = null;
    try { const r = await api("GET", officeApi("/readme")); if (docsOffice === id && Array.isArray(r?.files)) docs = r; } catch {}
    render(true);
  }
  async function loadProv() {
    provAt = Date.now();
    try { prov = await api("GET", "/api/providers"); } catch { prov = null; }
    render(true);
  }

  // panels: only navigation. A panel the guide opened is closed again when the step no longer needs it.
  const click = (id) => $(id)?.click();
  function ensurePanels() {
    const [kind, sub] = (step()[1].o || "").split(":");
    for (const k of [...opened]) if (k !== kind || !kind) { if (!$(MODALS[k]).hidden) click(CLOSERS[k]); opened.delete(k); }
    if (!kind) return;
    const modal = $(MODALS[kind]);
    if (modal.hidden) {
      if (kind === "settings") settingsUI.show(sub);
      else if (kind === "board") boardUI.show();
      else if (kind === "costs") costsUI.show();
      else if (kind === "inbox") click("btnInbox");
      else if (kind === "activity") click("btnActivity");
      else if (kind === "meetstart") click("btnMeeting");
      if (!modal.hidden) opened.add(kind);
    }
    if (kind === "settings" && sub && document.querySelector("#settingsTabs .on")?.dataset.tab !== sub) settingsUI.show(sub);
    if (kind === "board" && sub) {
      const pane = { tasks: "boardTasks", ideas: "boardIdeas", notes: "boardNotes" }[sub];
      if ($(pane).hidden) document.querySelector(`#boardTabs [data-tab="${sub}"]`)?.click();
    }
  }
  function closePanels() { for (const k of opened) if (!$(MODALS[k]).hidden) click(CLOSERS[k]); opened.clear(); }

  function go(s, i, focus = true) {
    menu = false; sec = s; idx = Math.max(0, Math.min(STEPS[s].length - 1, i));
    enteredAt = Date.now(); sig = ""; note = ""; scrolledFor = "";
    save(POS, { s: sec, i: idx });
    const seen = load(SEEN, {}); (seen[sec] ||= []); if (!seen[sec].includes(idx)) { seen[sec].push(idx); save(SEEN, seen); }
    const x = step()[1].x;
    if (x === "prov" && !prov) loadProv();
    if (x === "draft" || x === "result") loadDocs();
    ensurePanels();
    render(true, focus);
  }
  function showMenu(focus = true) { menu = true; closePanels(); sig = ""; render(true, focus); }
  const next = () => { if (idx < STEPS[sec].length - 1) go(sec, idx + 1); else showMenu(); };
  const back = () => { if (idx > 0) go(sec, idx - 1); else showMenu(); };
  const nextSection = () => { const n = SECS[SECS.indexOf(sec) + 1]; if (n) go(n, 0); else showMenu(); };

  const btn = (label, cls, fn, k) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn small " + cls; b.textContent = label; b.onclick = fn; if (k) b.dataset.k = k; return b; };

  function stepBody(id, def, e) {
    const text = [], acts = [], p = provOf(e), engine = e?.engine || "claude";
    const vars = {
      name: esc(e?.name), model: esc(modelName(e?.model) || "—"), provider: esc(p?.name || engine),
      path: esc(e?.workdir || e?.cwd || cur()?.info?.cwd || PO.projectDisplay || "."),
    };
    text.push(t(`ui.guide.s.${id}.b`, vars));
    if (def.chat && !chatOpen()) text.push(`<span class="guide-note">${esc(t(cur()?.employees.size ? "ui.guide.needChat" : "ui.guide.noEmployee"))}</span>`);
    else if (def.c && !firstMatches(def)) text.push(`<span class="guide-note">${esc(t("ui.guide.absent"))}</span>`);

    if (def.x === "folder") acts.push(btn(t("ui.guide.openOffices"), "ghost", () => { settingsUI.show("offices"); opened.add("settings"); }));
    if (def.x === "prov") {
      text.push(!prov ? t("ui.guide.provLoading") : !e ? t("ui.guide.needChat") : p ? (p.connected && p.enabled ? t("ui.guide.provOk", vars) : t(p.connected ? "ui.guide.provOff" : "ui.guide.provNo", vars)) : t("ui.guide.provUnknown"));
      acts.push(btn(t("ui.guide.recheck"), "ghost", loadProv, "recheck"));
    }
    if (def.x === "draft") {
      const readme = docs?.readme, others = (docs?.files || []).filter((f) => f !== readme);
      const draft = !docs ? t("ui.guide.draftText") : readme ? t("ui.guide.draftFile", { file: readme }) : t("ui.guide.draftWrite");
      if (docs && !readme) text.push(t("ui.guide.noReadme"));
      if (note) text.push(`<span class="guide-note">${esc(note)}</span>`);
      const input = $("chatInput");
      const put = (msg) => {
        if (input.value.trim() && input.value.trim() !== msg) { note = t("ui.guide.boxBusy"); render(true); return; }
        input.value = msg; input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); note = ""; render(true);
      };
      if (e) acts.push(btn(t("ui.guide.putDraft"), "primary", () => put(draft), "draft"));
      if (e && others.length) {
        text.push(t("ui.guide.otherDocs"));
        const row = document.createElement("div"); row.className = "guide-row";
        others.slice(0, 4).forEach((f) => row.appendChild(btn(f, "ghost", () => put(t("ui.guide.draftFile", { file: f })))));
        acts.push(row);
      }
      if (e?.pending?.length) text.push(t("ui.guide.permWait"));
      else if (e?.status === "error" || e?.status === "sick") text.push(t("ui.guide.failed"));
      else if (e?.status === "working" || e?.status === "waiting") text.push(t("ui.guide.working"));
    }
    if (def.x === "result") {
      const a = lastAnswer(e);
      const known = docs && a ? docs.files.find((f) => a.text.includes(f)) : null;
      const m = a && (docs ? known : /[\w./~-]+\.(?:md|markdown|txt|rst|adoc)\b/i.exec(a.text)?.[0]);
      text.push(a ? (m ? t("ui.guide.source", { file: esc(m) }) : t("ui.guide.noSource")) : t("ui.guide.noReply"));
      if (engine === "gemini") text.push(t("ui.guide.costGemini"));
      acts.push(btn(t("ui.guide.openCosts"), "ghost", () => { costsUI.show(); opened.add("costs"); }));
    }
    if (def.pg) {
      const emp = e || (cur()?.employees.size ? [...cur().employees.values()][0] : null);
      const o = encodeURIComponent(state.office);
      const href = def.pg === "hire" ? `hire.html?office=${o}` : emp ? `employee.html?office=${o}&id=${encodeURIComponent(emp.id)}#${def.pg}` : "";
      if (href) {
        const a = document.createElement("a"); a.className = "btn small ghost"; a.href = href; a.target = "_blank"; a.rel = "noopener";
        a.textContent = t(def.pg === "hire" ? "ui.guide.openHire" : "ui.guide.openProfile") + (def.pg === "hire" ? "" : ` · ${emp.name}`) + " ↗";
        a.title = t("ui.guide.newTab"); acts.push(a);
      } else text.push(`<span class="guide-note">${esc(t("ui.guide.noEmployee"))}</span>`);
    }
    return { text, acts };
  }
  const firstMatches = (def) => { try { return shown(document.querySelector(def.t[0])); } catch { return false; } };

  function targetFor(def) {
    if (!def.t) return chatOpen() ? pick(["#btnProfile"]) || pick(["#roster .roster-chip, #roster .srow"]) : pick(["#roster .roster-chip, #roster .srow", "#office"]);
    if (def.chat && !chatOpen()) return pick(["#roster .roster-chip, #roster .srow", "#office"]);
    return pick(def.t);
  }

  function renderMenu() {
    const seen = load(SEEN, {}), pos = load(POS, null);
    card.innerHTML = "";
    const head = document.createElement("div"); head.className = "guide-head"; head.tabIndex = -1;
    head.innerHTML = `<b id="guideTitle">${esc(t("ui.guide.menuTitle"))}</b>`;
    const x = btn("×", "ghost guide-x", () => finish("skipped")); x.setAttribute("aria-label", t("ui.guide.exit")); x.title = t("ui.guide.exit"); head.appendChild(x);
    const body = document.createElement("div"); body.className = "guide-text"; body.id = "guideBody";
    body.innerHTML = `<p>${esc(t("ui.guide.menuIntro"))}</p>`;
    const list = document.createElement("ul"); list.className = "guide-menu";
    if (pos && STEPS[pos.s]) {
      const li = document.createElement("li");
      const b = btn(t("ui.guide.menuResume", { sec: sname(pos.s), i: pos.i + 1 }), "primary guide-resume", () => go(pos.s, pos.i), "resume");
      li.appendChild(b); list.appendChild(li);
    }
    for (const s of SECS) {
      const li = document.createElement("li"), n = STEPS[s].length, a = (seen[s] || []).length;
      const b = document.createElement("button"); b.type = "button"; b.className = "guide-sec-btn"; b.dataset.k = "s" + s;
      b.innerHTML = `<span class="guide-sec-k">${s}</span><span class="guide-sec-t"><b>${esc(sname(s))}</b><small>${esc(t(`ui.guide.sec.${s}.d`))}</small></span><span class="guide-sec-n">${esc(a ? t("ui.guide.seen", { a, n }) : t("ui.guide.stepsN", { n }))}</span>`;
      b.onclick = () => go(s, 0);
      li.appendChild(b); list.appendChild(li);
    }
    body.appendChild(list);
    const foot = document.createElement("div"); foot.className = "guide-acts";
    foot.append(btn(t("ui.guide.exitMenu"), "ghost", () => finish("skipped"), "exit"));
    card.append(head, body, foot);
  }

  function render(force, focus) {
    if (!active) return;
    card.dataset.menu = menu ? "1" : "";
    if (menu) {
      if (force || sig !== "menu") { sig = "menu"; renderMenu(); }
      placeMenu();
      if (focus) card.querySelector(".guide-head")?.focus({ preventScroll: true });
      return;
    }
    const e = sel(), [id, def] = step(), tgt = targetFor(def);
    const key = [id, e?.id, e?.status, e?.pending?.length, !!prov, provOf(e)?.connected, provOf(e)?.enabled, $("chatInput").value ? 1 : 0, chatOpen(), note, lastAnswer(e)?.ts, !!tgt, !!docs, document.documentElement.lang].join("|");
    if (force || key !== sig) {
      sig = key;
      const had = card.contains(document.activeElement), kept = had ? document.activeElement.dataset?.k : "";
      const { text, acts } = stepBody(id, def, e);
      const n = STEPS[sec].length, last = idx === n - 1;
      card.innerHTML = "";
      const head = document.createElement("div"); head.className = "guide-head"; head.tabIndex = -1;
      head.innerHTML = `<span class="guide-count" aria-label="${esc(t("ui.guide.counterAria", { sec: sname(sec), i: idx + 1, n }))}">${sec}${idx + 1}</span><b id="guideTitle">${esc(t(`ui.guide.s.${id}.t`))}</b>`;
      const x = btn("×", "ghost guide-x", () => finish("skipped")); x.setAttribute("aria-label", t("ui.guide.exit")); x.title = t("ui.guide.exit"); head.appendChild(x);
      const bar = document.createElement("div"); bar.className = "guide-bar"; bar.setAttribute("aria-hidden", "true");
      bar.innerHTML = `<i style="width:${((idx + 1) / n) * 100}%"></i>`;
      const p = document.createElement("div"); p.className = "guide-text"; p.id = "guideBody";
      p.innerHTML = text.map((s) => `<p>${s}</p>`).join("");
      const extra = document.createElement("div"); extra.className = "guide-acts guide-extra"; extra.append(...acts);
      const nav = document.createElement("div"); nav.className = "guide-nav";
      nav.append(
        btn(t("ui.guide.back"), "ghost", back, "back"),
        btn(last ? t("ui.guide.sections") : t("ui.guide.next"), "primary", next, "next"),
      );
      const more = document.createElement("div"); more.className = "guide-acts guide-more";
      if (!last) more.append(btn(t("ui.guide.skipSection"), "ghost guide-skip", nextSection, "skipsec"));
      more.append(btn(t("ui.guide.sections"), "ghost guide-skip", () => showMenu(), "menu"));
      if (last && sec === SECS[SECS.length - 1]) more.append(btn(t("ui.guide.finish"), "ghost guide-skip", () => finish("done"), "finish"));
      card.append(head, bar, p);
      if (acts.length) card.append(extra);
      card.append(nav, more);
      if (had) (kept && card.querySelector(`[data-k="${kept}"]`) || head).focus({ preventScroll: true });
    }
    if (focus) card.querySelector(".guide-head")?.focus({ preventScroll: true });
    if (tgt && scrolledFor !== id + sig.length) {
      scrolledFor = id + sig.length;
      const box = tgt.closest(".modal-card, .chat-body, .settings-card");
      if (box) { const r = tgt.getBoundingClientRect(), b = box.getBoundingClientRect(); if (r.top < b.top || r.bottom > b.bottom) tgt.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" }); }
    }
    place(tgt);
  }

  function placeMenu() {
    ring.hidden = true; card.dataset.arrow = "";
    Object.assign(card.style, { width: "", right: "auto", bottom: "auto" });
    const cw = card.offsetWidth, ch = card.offsetHeight;
    card.style.left = Math.max(8, (innerWidth - cw) / 2) + "px";
    card.style.top = Math.max(8, (innerHeight - ch) / 2) + "px";
  }

  // ring around the real element (clamped to the screen), arrow on the card side facing it; none on screen: no ring
  function place(tgt) {
    const narrow = innerWidth < 700;
    const r = tgt ? tgt.getBoundingClientRect() : null;
    ring.hidden = !r;
    card.dataset.arrow = "";
    if (r) {
      const l = Math.max(2, r.left - 4), tp = Math.max(2, r.top - 4), rr = Math.min(innerWidth - 2, r.right + 4), bb = Math.min(innerHeight - 2, r.bottom + 4);
      Object.assign(ring.style, { left: l + "px", top: tp + "px", width: Math.max(8, rr - l) + "px", height: Math.max(8, bb - tp) + "px" });
    }
    const W = innerWidth, H = innerHeight;
    card.style.width = narrow ? "calc(100% - 16px)" : "";
    const cw = card.offsetWidth, ch = card.offsetHeight;
    if (narrow || !r) {
      const top = narrow && r && r.top > H / 2;
      Object.assign(card.style, { left: narrow ? "8px" : "auto", right: narrow ? "auto" : "12px", top: top ? "56px" : "auto", bottom: top ? "auto" : "12px" });
      return;
    }
    card.style.bottom = "auto"; card.style.right = "auto";
    let left, top;
    if (r.bottom + ch + 24 < H) { top = r.bottom + 14; card.dataset.arrow = "up"; left = r.left + r.width / 2 - cw / 2; }
    else if (r.top - ch - 24 > 0) { top = r.top - ch - 14; card.dataset.arrow = "down"; left = r.left + r.width / 2 - cw / 2; }
    else if (r.left - cw - 24 > 0) { left = r.left - cw - 14; card.dataset.arrow = "right"; top = r.top + r.height / 2 - ch / 2; }
    else if (r.right + cw + 24 < W) { left = r.right + 14; card.dataset.arrow = "left"; top = r.top + r.height / 2 - ch / 2; }
    else { left = W - cw - 12; top = H - ch - 12; }
    left = Math.max(8, Math.min(W - cw - 8, left)); top = Math.max(8, Math.min(H - ch - 8, top));
    card.style.left = left + "px"; card.style.top = top + "px";
    if (card.dataset.arrow === "up" || card.dataset.arrow === "down") card.style.setProperty("--ax", Math.max(14, Math.min(cw - 14, r.left + r.width / 2 - left)) + "px");
    else if (card.dataset.arrow) card.style.setProperty("--ay", Math.max(14, Math.min(ch - 14, r.top + r.height / 2 - top)) + "px");
  }

  function start(s) {
    if (active) { if (s) go(s, 0); return; }
    active = true; sig = "";
    $("welcomeModal").hidden = true;
    card.hidden = false;
    try { sessionStorage.setItem(ON, "1"); } catch {}
    timer = setInterval(() => { if (!document.hidden) render(); }, 600);
    if (s) go(s, 0); else showMenu();
  }
  function finish(how) {
    if (!active) return;
    active = false; clearInterval(timer); card.hidden = true; ring.hidden = true;
    closePanels();
    try { sessionStorage.removeItem(ON); } catch {}
    store(how);
    if (how === "done") toast(t("ui.guide.done"));
  }

  window.addEventListener("resize", () => render());
  // Esc inside the guide closes only the guide; with a panel open and focus elsewhere it closes just the panel
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !active || ev.defaultPrevented) return;
    if (!card.contains(document.activeElement)) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    finish("skipped");
  }, true);

  $("btnGuide").onclick = () => (active ? finish("skipped") : start());
  $("welcomeGuide").onclick = () => { try { localStorage.setItem("po.welcomed", "1"); } catch {} start("B"); };
  const qg = new URLSearchParams(location.search).get("guide");
  const resumed = (() => { try { return sessionStorage.getItem(ON) === "1"; } catch { return false; } })();
  if (qg) start(SECS.includes(qg.toUpperCase()) ? qg.toUpperCase() : "B");
  else if (resumed) { const p = load(POS, null); start(); if (p && STEPS[p.s]) go(p.s, p.i, false); }
  return { start, finish, get active() { return active; }, get state() { return stored(); } };
})();
