// Office layout editor (✏️ in the top bar): move, copy, rotate, delete and add pieces of furniture on the tile grid. New pieces come from the
// Market drawer (web/market.js: prices, rarity, the wallet and the depot of pieces you took down): pick a card, a ghost follows the pointer,
// a click places it (and pays), Enter places it for you. The wallet is part of the draft: Cancel and Undo give the coins back.
// Rooms, walls, doors and the windows are fixed; the wall decor (posters, clocks, screens ...) hangs on the top wall and is edited the same way. Every drop is checked by POLayout.check (on the floor, not on walls / doors / other pieces,
// every desk, hangout spot and doorway still reachable on foot, the entrance open). Changes show live in the office (people keep
// walking and re-route); Save sends the layout to the server (which checks it again), Cancel puts the saved one back.
const layoutEditor = (() => {
  const L = POLayout, TILE_PX = 32, tr = t; // (tr: the drawing code below has its own `t`, the animation clock)
  const btn = $("btnLayout");
  const stage = document.querySelector("main.stage");
  const canvas = office.canvas;
  let active = false, items = [], startJson = "", base = null, undo = [], selected = null, drag = null, hover = null, ghost = null;
  let wallet = POMarket.newWallet(), walletStart = "", placing = null, pending = null, mkDrag = null, fx = [], suppressClick = 0;
  let starters = new Set(); // ids of the pieces the office itself started with (taking one down or selling it is remembered: see POMarket)
  let editTheme = "", resetFlag = false, saving = false, comparing = false, msg = { text: "", bad: false };

  // ---------- the bar under the office ----------
  const bar = document.createElement("div");
  bar.className = "layout-bar";
  bar.hidden = true;
  bar.innerHTML = `
    <div class="lb-head"><b>${escapeHtml(t("ui.layout.title"))}</b><span class="lb-hint">${escapeHtml(t("ui.layout.hint"))}</span><span class="lb-msg" id="lbMsg" role="status"></span></div>
    <div class="lb-body">
      <div class="lb-actions">
        <button class="btn small" id="lbUndo" type="button" title="Ctrl+Z">↶ ${escapeHtml(t("ui.layout.undo"))}</button>
        <button class="btn small" id="lbRotate" type="button" title="R">⟳ ${escapeHtml(t("ui.layout.rotate"))}</button>
        <button class="btn small" id="lbCopy" type="button" title="Ctrl+D">⧉ ${escapeHtml(t("ui.layout.copy"))}</button>
        <button class="btn small danger" id="lbDelete" type="button" title="Del">🗑 ${escapeHtml(t("ui.layout.delete"))}</button>
        <button class="btn small" id="lbSell" type="button" title="${escapeHtml(t("ui.market.sellTipBar"))}">🪙 ${escapeHtml(t("ui.market.sellBar"))}</button>
        <button class="btn small" id="lbCompare" type="button" title="C">👁 ${escapeHtml(t("ui.layout.compare"))}</button>
        <span class="lb-sep"></span>
        <button class="btn small ghost" id="lbReset" type="button">${escapeHtml(t("ui.layout.reset"))}</button>
        <button class="btn small" id="lbCancel" type="button" title="Esc">${escapeHtml(t("ui.layout.cancel"))}</button>
        <button class="btn small primary" id="lbSave" type="button">${escapeHtml(t("ui.layout.save"))}</button>
      </div>
    </div>`;
  stage.appendChild(bar);
  const q = (id) => bar.querySelector("#" + id);
  // ---------- the market: a drawer on the right while the editor is on ----------
  const M = POMarket;
  const market = document.createElement("aside");
  market.className = "market"; market.id = "market";
  market.setAttribute("aria-label", t("ui.market.title"));
  market.innerHTML = `
    <div class="mk-head"><b>${escapeHtml(t("ui.market.depotTitle"))}</b><span class="mk-head-r"><button class="mk-mute" id="mkMute" type="button"></button><span class="mk-coins" id="mkCoins" title="${escapeHtml(t("ui.market.coinsTip"))}"></span></span></div>
    <button class="mk-open" id="mkOpen" type="button"><span class="mk-open-ico" aria-hidden="true">🛒</span><span><b>${escapeHtml(t("ui.market.openShop"))}</b><small>${escapeHtml(t("ui.market.openShopSub"))} <kbd>M</kbd></small></span></button>
    <p class="mk-depot-hint">${escapeHtml(t("ui.market.depotHint"))}</p>
    <div class="mk-grid" id="mkGrid"></div>`;
  document.body.appendChild(market);
  const mq = (id) => market.querySelector("#" + id);
  const tt = (k, fallback) => { const v = t(k); return v === k ? fallback : v; };
  const hasSkin = (th, type) => window.themeHasSkin(th, type);
  // a market key's name: the look's own name where it has one (Throne, Armor ...), else the piece's
  const pieceName = (key) => { const i = M.info(key); if (!i) return key; const base = t("ui.layout.type." + i.type); return i.skin ? tt(`ui.market.skin.${i.skin}.${i.type}`, base) : base; };
  // the look a placed piece wears now: its own, or (a piece that follows the theme) the office's, or the classic one where the theme has none
  const lookOf = (it) => it.skin || (hasSkin(office.theme, it.type) ? office.theme : "default");
  const effKey = (it) => (isWall(it) || it.type === "desk" ? it.type : it.type + "@" + lookOf(it));
  const itemName = (it) => pieceName(effKey(it));
  const placedCount = (key) => items.filter((i) => effKey(i) === key).length;

  // ---------- feedback: a little sound, a floating "-60", a flash on the coins and a ring where the piece lands ----------
  const soundOn = () => { try { return localStorage.getItem("po.market.mute") !== "1"; } catch { return true; } };
  let actx = null;
  const NOTES = { // [frequency, start, length, wave, volume]
    buy: [[988, 0, .09, "square", .06], [1319, .09, .2, "square", .06]],
    sell: [[1319, 0, .08, "square", .05], [988, .08, .16, "square", .05]],
    place: [[330, 0, .05, "triangle", .09], [220, .04, .08, "triangle", .07]],
    error: [[170, 0, .14, "sawtooth", .05]],
  };
  function sfx(kind) {
    if (!soundOn()) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
      const t0 = actx.currentTime;
      for (const [f, at0, len, wave, vol] of NOTES[kind]) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = wave; o.frequency.value = f;
        g.gain.setValueAtTime(vol, t0 + at0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at0 + len);
        o.connect(g); g.connect(actx.destination);
        o.start(t0 + at0); o.stop(t0 + at0 + len + 0.03);
      }
    } catch { /* no audio in this browser: the rest of the feedback is enough */ }
  }
  function paintMute() {
    const b = mq("mkMute"), on = soundOn();
    b.textContent = on ? "🔊" : "🔇"; b.title = t(on ? "ui.market.soundOn" : "ui.market.soundOff"); b.setAttribute("aria-pressed", on ? "false" : "true");
  }
  function floatText(text) {
    const chip = mq("mkCoins"), el = document.createElement("span");
    el.className = "mk-float"; el.textContent = text;
    chip.appendChild(el);
    chip.classList.remove("pulse"); void chip.offsetWidth; chip.classList.add("pulse");
    setTimeout(() => el.remove(), 1000);
  }
  // a piece has just been placed: paid = coins it cost (0 = free / from the depot)
  function celebrate(it, paid) {
    sfx(paid ? "buy" : "place");
    if (paid) floatText("−" + paid);
    if (typeof REDUCED_MOTION !== "undefined" && REDUCED_MOTION.matches) return;
    const tiles = L.tilesOf(it);
    if (!tiles.length) return; // (ambient decor: nothing to ring)
    const xs = tiles.map((q) => q[0]), ys = tiles.map((q) => q[1]);
    fx.push({ cx: (Math.min(...xs) + Math.max(...xs) + 1) * TILE_PX / 2, cy: (Math.min(...ys) + Math.max(...ys) + 1) * TILE_PX / 2, t0: performance.now(), gold: !!paid });
  }
  function drawFx(b) {
    const now = performance.now();
    fx = fx.filter((f) => now - f.t0 < 750);
    for (const f of fx) {
      const k = (now - f.t0) / 750, r = 8 + k * 30;
      b.save(); b.globalAlpha = 1 - k; b.fillStyle = f.gold ? "#ffd166" : "#f5f0e6";
      for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2 + k * 1.2; b.fillRect(Math.round(f.cx + Math.cos(a) * r) - 2, Math.round(f.cy + Math.sin(a) * r * 0.6) - 2, 4, 4); }
      b.restore();
    }
  }

  // ---------- asking before paying: the piece waits at its spot until you say yes ----------
  const confirmEl = document.createElement("div");
  confirmEl.className = "mk-confirm"; confirmEl.hidden = true; confirmEl.setAttribute("role", "alertdialog");
  office.canvas.parentElement.appendChild(confirmEl);
  function clearPending() { pending = null; ghost = null; confirmEl.hidden = true; }
  // A piece is to go at `spot`. Free ones (desks, from the depot) are placed at once; paid ones wait for a yes.
  function propose(spot, keep = false, from = "auto") {
    const key = M.keyOf(spot), i = M.info(key);
    if (i.price === 0 || M.inDepot(wallet, key) > 0) { buyAndPlace(spot); return; }
    stopPlacing(true);
    pending = { item: spot, key, keep, from };
    ghost = L.tilesOf(spot).length ? { item: spot, res: { ok: true, errors: [] } } : null; // (ambient decor has no spot to show)
    const name = pieceName(key);
    confirmEl.innerHTML = `<span class="mkc-text"><span class="mkc-line"><b>${escapeHtml(name)}</b><span class="mkc-price"><i class="mk-coin"></i>${i.price}</span></span><small>${escapeHtml(t("ui.market.left", { left: wallet.coins - i.price }))}</small></span>` +
      `<button class="btn small primary" id="mkcBuy" type="button">${escapeHtml(t("ui.market.buy"))} <kbd>⏎</kbd></button><button class="btn small" id="mkcNo" type="button">${escapeHtml(t("ui.market.notNow"))} <kbd>Esc</kbd></button>`;
    confirmEl.querySelector("#mkcBuy").onclick = confirmPending;
    confirmEl.querySelector("#mkcNo").onclick = cancelPending;
    confirmEl.hidden = false;
    say(t("ui.market.confirmAsk", { name, price: i.price }));
    refreshButtons(); renderMarket();
  }
  function confirmPending() {
    const p = pending;
    if (!p) return;
    clearPending();
    const done = buyAndPlace(p.item);
    if (!done) sfx("error");
    else if (p.keep && M.canAfford(wallet, p.key)) startPlacing(p.key);
  }
  function cancelPending() {
    const p = pending;
    if (!p) return;
    clearPending();
    refreshButtons(); renderMarket();
    if (p.from === "click") startPlacing(p.key); // (a click-placed piece: straight back to choosing a spot)
  }

  // The drawer shows the depot: what you own and have not placed. Drag a piece into the office (or click, then click a spot): placing is free.
  // Browsing and buying happen in the shop (web/shop.js), which listens for changes here.
  const listeners = [];
  function renderMarket() {
    if (!active) return;
    mq("mkCoins").innerHTML = `<i class="mk-coin"></i>${wallet.coins}`;
    const grid = mq("mkGrid");
    grid.textContent = "";
    const theme = office.theme;
    const list = Object.keys(wallet.depot).map(M.info).filter(Boolean);
    mq("mkOpen").classList.toggle("has-depot", list.length > 0);
    if (!list.length) { const e = document.createElement("p"); e.className = "mk-empty"; e.textContent = t("ui.market.emptyDepot"); grid.appendChild(e); }
    for (const i of list) {
      const inDepot = M.inDepot(wallet, i.key), name = pieceName(i.key);
      const card = document.createElement("div");
      card.className = `mk-card r-${i.rarity}${placing && placing.key === i.key ? " on" : ""}`;
      const pick = document.createElement("button");
      pick.type = "button"; pick.className = "mk-pick";
      pick.title = t(i.ambient ? "ui.market.hangTip" : "ui.market.pickTip", { name });
      pick.innerHTML = `<span class="mk-thumb"><img alt="" src="${renderItemThumb(theme, i.type, i.skin || undefined)}"></span><span class="mk-name">${escapeHtml(name)}</span>` +
        `<span class="mk-meta"><span class="mk-rar">${escapeHtml(t("ui.market.rarity." + i.rarity))}</span><span class="mk-price">×${inDepot}</span></span>`;
      const img = pick.querySelector("img"); // (twice their size: the piece art is small)
      img.onload = () => { img.width = img.naturalWidth * 2; img.height = img.naturalHeight * 2; };
      pick.draggable = false; img.draggable = false;
      pick.onpointerdown = (ev) => cardDown(ev, i.key, img.src);
      pick.onclick = () => { if (performance.now() - suppressClick > 300) startPlacing(i.key); }; // (a click that ends a drag is not a pick)
      card.appendChild(pick);
      if (!i.ambient) {
        const auto = document.createElement("button");
        auto.type = "button"; auto.className = "mk-auto"; auto.textContent = "⚡"; auto.title = t("ui.market.autoTip"); auto.setAttribute("aria-label", t("ui.market.autoTip"));
        auto.onclick = () => add(i.key);
        card.appendChild(auto);
      }
      if (M.stored(i.key)) {
        const sell = document.createElement("button");
        sell.type = "button"; sell.className = "mk-sell";
        sell.textContent = t("ui.market.sell", { gain: M.sellPrice(i.key) });
        sell.title = t("ui.market.sellTip", { gain: M.sellPrice(i.key), percent: Math.round(M.REFUND * 100) });
        sell.onclick = () => sellOne(i.key);
        card.appendChild(sell);
      }
      grid.appendChild(card);
    }
    for (const fn of listeners) fn();
  }
  mq("mkMute").onclick = () => { try { localStorage.setItem("po.market.mute", soundOn() ? "1" : "0"); } catch {} paintMute(); sfx("place"); };
  mq("mkOpen").onclick = () => { if (window.marketShop) window.marketShop.open(); };

  // ---------- state helpers ----------
  const ids = () => office.rosterIds || [];
  const check = (list) => L.check(list, { empCount: ids().length });
  const find = (id) => items.find((i) => i.id === id);
  const put = (list, it) => list.map((x) => (x.id === it.id ? it : x));
  const nameOf = (empId) => { const e = office.emps.find((x) => x.id === empId); return e ? e.name : empId; };
  const ownerOf = (deskId) => { const { map } = L.assignDesks(items, ids()); for (const [emp, d] of map) if (d === deskId) return nameOf(emp); return ""; };
  const layoutDirty = () => JSON.stringify(items) !== startJson || (resetFlag && base !== null);
  const walletDirty = () => JSON.stringify(wallet) !== walletStart;
  const dirty = () => layoutDirty() || walletDirty();
  const say = (text, bad = false) => { msg = { text, bad }; const el = q("lbMsg"); el.textContent = text; el.classList.toggle("bad", bad); };
  const why = (res) => {
    const e = res.errors.find((x) => x.code !== "desks") || res.errors[0];
    return e ? t("ui.layout.err." + e.code) : "";
  };
  const isWall = (it) => !!(L.TYPES[it.type] && L.TYPES[it.type].wall);

  function refreshButtons() {
    const it = selected && find(selected);
    q("lbUndo").disabled = !undo.length;
    q("lbRotate").disabled = !(it && L.TYPES[it.type].dirs);
    q("lbCopy").disabled = !it;
    q("lbDelete").disabled = !it;
    q("lbSell").disabled = !it || it.type === "desk";
    q("lbSave").disabled = saving;
    if (!drag) say(placing && !(ghost && !ghost.res.ok) ? t("ui.market.placing", { name: pieceName(placing.key) }) : it ? t("ui.layout.selected", { name: itemName(it) + (it.type === "desk" && ownerOf(it.id) ? " · " + ownerOf(it.id) : "") }) : "");
  }

  // show the working copy in the office right away
  function apply() {
    office.applyLayout(L.toDoc(items, true)); // (stored decor: what is in `items` is all there is, so a bare wall stays bare)
    refreshButtons();
    renderMarket();
  }
  // (the wallet is part of the draft: an undo gives the coins back)
  function commit(next, keepReset = false, nextWallet = wallet) {
    undo.push({ items, resetFlag, wallet });
    if (undo.length > 60) undo.shift();
    items = next; wallet = nextWallet;
    if (!keepReset) resetFlag = false;
    apply();
  }

  // hold to look at the saved office (before), let go to come back to the working copy (after)
  function compare(on) {
    if (!active || on === comparing) return;
    if (on && (drag || saving || pending || mkDrag)) return;
    comparing = on;
    q("lbCompare").classList.toggle("active", on);
    if (on) { office.applyLayout(cur().layout || null); ghost = null; say(t("ui.layout.comparing")); }
    else apply();
  }

  // ---------- pieces ----------
  const protoOf = (key) => { const i = M.info(key); return { id: "new", type: i.type, ...(i.skin ? { skin: i.skin } : {}), ...(i.type === "plant" ? { v: 1, water: true } : {}), ...(L.DEFAULT_DIR[i.type] ? { dir: L.DEFAULT_DIR[i.type] } : {}) }; };
  const owns = (w, it) => (M.info(M.keyOf(it)).price > 0 ? M.own(w, it.id) : w); // (what you paid for can go back to the depot)
  // Pay for one piece (from the depot when there is one) and put it in the layout at `spot`; says what happened.
  function buyAndPlace(spot) {
    const key = M.keyOf(spot), r = M.acquire(wallet, key);
    if (!r.ok) { say(t("ui.market.noCoins", { price: r.price }), true); sfx("error"); return false; }
    const it = { ...spot, id: L.nextId(items, spot.type) };
    commit([...items, it], false, owns(r.wallet, it));
    selected = isWall(it) && L.TYPES[it.type].wall.ambient ? null : it.id;
    refreshButtons();
    const name = pieceName(key);
    say(r.fromDepot ? t("ui.market.fromDepotMsg", { name }) : r.paid ? t("ui.market.bought", { name, price: r.paid }) : t("ui.market.placed", { name }));
    celebrate(it, r.paid);
    return true;
  }
  // the market's "place it for me": the free spot nearest to the pointer / the selected piece / the middle of the office
  function add(key) {
    if (!active || comparing || saving) return;
    const i = M.info(key);
    if (!M.canAfford(wallet, key)) { say(t("ui.market.noCoins", { price: i.price }), true); return; }
    if (i.ambient) { startPlacing(key); return; } // (decor that spans the wall has no spot to pick)
    const wall = !!L.TYPES[i.type].wall, proto = placing && placing.key === key ? { ...placing.proto } : protoOf(key);
    const cur = selected && find(selected);
    const near = hover ? [hover.tx, wall ? 0 : hover.ty] : cur ? [cur.tx, wall ? 0 : cur.ty] : [14, wall ? 0 : 9];
    const spot = L.findPlace(items, proto, near, { empCount: ids().length });
    if (!spot) { say(t("ui.layout.noRoom"), true); return; }
    stopPlacing(true);
    propose(spot, false, "auto");
  }
  function startPlacing(key) {
    if (!active || comparing || saving) return;
    clearPending();
    const i = M.info(key);
    if (!M.canAfford(wallet, key)) { say(t("ui.market.noCoins", { price: i.price }), true); return; }
    if (i.ambient) { // ambient decor is just hung: it takes no spot (and only one of each)
      if (items.some((x) => x.type === i.type)) { say(t("ui.market.alreadyHung", { name: pieceName(key) }), true); return; }
      stopPlacing(true);
      propose({ ...protoOf(key), id: L.nextId(items, i.type), tx: 0, ty: 0 }, false, "auto");
      return;
    }
    placing = { key, type: i.type, proto: protoOf(key) };
    selected = null; ghost = null; drag = null;
    canvas.style.cursor = "copy";
    refreshButtons(); renderMarket();
  }
  function stopPlacing(quiet = false) {
    if (!placing) return;
    placing = null; ghost = null;
    canvas.style.cursor = "default";
    if (!quiet) { refreshButtons(); renderMarket(); }
  }
  // where the piece being placed would go with the pointer at p (centred on the pointer; wall decor slides along the wall)
  function ghostAt(p) {
    const proto = placing.proto, wall = !!L.TYPES[proto.type].wall;
    const tiles = L.tilesOf({ ...proto, tx: 0, ty: 0 }), xs = tiles.map((q) => q[0]), ys = tiles.map((q) => q[1]);
    const minX = Math.min(...xs), w = Math.max(...xs) - minX + 1;
    let tx = p.tx - minX - Math.floor((w - 1) / 2);
    if (wall) tx = Math.max(0, Math.min(L.COLS - L.TYPES[proto.type].wall.w, tx));
    const item = { ...proto, id: L.nextId(items, proto.type), tx, ty: wall ? 0 : p.ty - Math.max(...ys) };
    return { item, res: check([...items, item]) };
  }
  // Drag a card into the office: a picture follows the pointer, the piece's ghost shows where it would go, letting go proposes it there.
  // (a plain click still picks the card; touch screens use tap-then-tap because a drag there scrolls the market)
  function cardDown(ev, key, src) {
    if (ev.button !== 0 || ev.pointerType === "touch" || !active || comparing || saving || pending || M.info(key).ambient) return;
    mkDrag = { key, src, sx: ev.clientX, sy: ev.clientY, on: false, img: null };
    window.addEventListener("pointermove", cardMove);
    window.addEventListener("pointerup", cardUp);
    window.addEventListener("pointercancel", cardUp);
  }
  const overOffice = (ev) => { const r = canvas.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX < r.right && ev.clientY >= r.top && ev.clientY < r.bottom; };
  function cardMove(ev) {
    const d = mkDrag;
    if (!d) return;
    if (!d.on) {
      if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 6) return;
      if (!M.canAfford(wallet, d.key)) { say(t("ui.market.noCoins", { price: M.info(d.key).price }), true); sfx("error"); endCardDrag(); return; }
      d.on = true;
      startPlacing(d.key);
      document.body.classList.add("mk-dragging");
      d.img = document.createElement("img");
      d.img.className = "mk-dragimg"; d.img.src = d.src; d.img.alt = ""; d.img.draggable = false;
      d.img.onload = () => { d.img.width = d.img.naturalWidth * 2; d.img.height = d.img.naturalHeight * 2; };
      document.body.appendChild(d.img);
    }
    d.img.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px) translate(-50%, -50%)`;
    if (!placing) return;
    if (overOffice(ev)) { // over the office the piece's ghost replaces the picture
      const p = at(ev);
      hover = { tx: p.tx, ty: p.ty };
      ghost = ghostAt(p);
      d.img.style.visibility = "hidden";
      say(ghost.res.ok ? t("ui.market.dropHint", { name: pieceName(d.key) }) : why(ghost.res), !ghost.res.ok);
    } else { ghost = null; d.img.style.visibility = "visible"; }
  }
  function endCardDrag() {
    window.removeEventListener("pointermove", cardMove);
    window.removeEventListener("pointerup", cardUp);
    window.removeEventListener("pointercancel", cardUp);
    document.body.classList.remove("mk-dragging");
    if (mkDrag && mkDrag.img) mkDrag.img.remove();
    mkDrag = null;
  }
  function cardUp(ev) {
    const d = mkDrag;
    endCardDrag();
    if (!d || !d.on) return;
    suppressClick = performance.now();
    if (!placing) return; // (Esc during the drag)
    if (ev.type === "pointerup" && overOffice(ev)) {
      const g = ghostAt(at(ev));
      if (g.res.ok) { stopPlacing(true); propose(g.item, false, "drag"); return; }
      say(why(g.res), true); sfx("error");
    }
    stopPlacing(true);
    ghost = null;
    refreshButtons(); renderMarket();
  }
  function rotatePlacing() {
    if (!placing || !L.TYPES[placing.type].dirs) return;
    placing.proto = L.rotate(placing.proto);
    if (hover) ghost = ghostAt(hover);
  }
  function takeDownAmbient(type) { // ambient decor is taken down from its card (nothing on the canvas to click)
    const it = items.find((x) => x.type === type);
    if (!it) return false;
    const d = M.discard(wallet, it, effKey(it), starters.has(it.id));
    commit(items.filter((x) => x.id !== it.id), false, d.wallet);
    if (d.stashed) say(t("ui.market.toDepot", { name: itemName(it) }));
    return true;
  }
  // Sell a placed piece (any of yours, the office's own included): it leaves the office and pays 80% of the usual price. Undo brings it back.
  function sellItemNow(it) {
    if (!active || comparing || saving || pending || !it || it.type === "desk") return false;
    const next = items.filter((x) => x.id !== it.id), res = check(next);
    if (!res.ok) { say(why(res), true); return false; }
    const r = M.sellItem(wallet, it, effKey(it), starters.has(it.id));
    if (!r.ok) { say(t("ui.market.cannotSell"), true); sfx("error"); return false; }
    commit(next, false, r.wallet);
    if (selected === it.id) selected = null;
    refreshButtons();
    say(t("ui.market.soldPlaced", { name: itemName(it), gain: r.gain }));
    sfx("sell"); floatText("+" + r.gain);
    return true;
  }
  const placedOf = (key) => items.filter((x) => x.type !== "desk" && effKey(x) === key);
  function sellPlaced(key) { const list = placedOf(key); return list.length ? sellItemNow(list[list.length - 1]) : false; }
  function showPlaced(key) { // select one of them in the office (the shop steps aside)
    const it = placedOf(key)[0];
    if (!it) return false;
    selected = it.id; refreshButtons();
    if (!(typeof REDUCED_MOTION !== "undefined" && REDUCED_MOTION.matches)) { const tiles = L.tilesOf(it); if (tiles.length) { const xs = tiles.map((q) => q[0]), ys = tiles.map((q) => q[1]); fx.push({ cx: (Math.min(...xs) + Math.max(...xs) + 1) * TILE_PX / 2, cy: (Math.min(...ys) + Math.max(...ys) + 1) * TILE_PX / 2, t0: performance.now(), gold: false }); } }
    return true;
  }
  // The shop's "buy": the piece goes to the depot (placing it later is free). Part of the draft, like everything with coins.
  function buyToDepot(key, n = 1) {
    if (!active || comparing || saving || pending) return false;
    const r = M.purchase(wallet, key, n);
    if (!r.ok) { say(t("ui.market.noCoins", { price: r.price }), true); sfx("error"); return false; }
    undo.push({ items, resetFlag, wallet });
    if (undo.length > 60) undo.shift();
    wallet = r.wallet;
    refreshButtons(); renderMarket();
    say(t("ui.market.boughtDepot", { name: pieceName(key) + (n > 1 ? " ×" + n : ""), price: r.paid }));
    sfx("buy"); floatText("−" + r.paid);
    return true;
  }
  // Ambient decor hung from the shop (already asked there): from the depot when there is one, else paid.
  function hangAmbient(key) {
    const i = M.info(key);
    if (!active || comparing || saving || pending || !i || !i.ambient || items.some((x) => x.type === i.type)) return false;
    return buyAndPlace({ ...protoOf(key), id: L.nextId(items, i.type), tx: 0, ty: 0 });
  }
  function sellOne(key) {
    const r = M.sell(wallet, key);
    if (!r.ok) return false;
    undo.push({ items, resetFlag, wallet });
    wallet = r.wallet;
    refreshButtons(); renderMarket();
    say(t("ui.market.sold", { name: pieceName(key), gain: r.gain }));
    sfx("sell"); floatText("+" + r.gain);
    return true;
  }
  function remove() {
    const it = selected && find(selected);
    if (!it) return;
    const r = L.canDelete(items, it.id, ids());
    if (!r.ok) { say(r.reason === "assigned" ? t("ui.layout.err.assigned", { name: ownerOf(it.id) }) : t("ui.layout.err." + r.reason), true); return; }
    const next = items.filter((x) => x.id !== it.id);
    const res = check(next);
    if (!res.ok) { say(why(res), true); return; } // (e.g. taking a piece away opens no hole, but be safe)
    const d = M.discard(wallet, it, effKey(it), starters.has(it.id));
    commit(next, false, d.wallet);
    selected = null;
    refreshButtons();
    if (d.stashed) say(t("ui.market.toDepot", { name: itemName(it) }));
  }
  function copy() { // a copy is bought like any other piece
    const it = selected && find(selected);
    if (!it) return;
    if (!M.canAfford(wallet, M.keyOf(it))) { say(t("ui.market.noCoins", { price: M.info(M.keyOf(it)).price }), true); return; }
    const proto = { ...it, id: L.nextId(items, it.type) };
    delete proto.emp;
    const placed = L.findPlace(items, proto, [it.tx, it.ty], { empCount: ids().length });
    if (!placed) { say(t("ui.layout.noRoom"), true); return; }
    propose(placed, false, "auto");
  }
  function rotate() {
    const it = selected && find(selected);
    if (!it || !L.TYPES[it.type].dirs) return;
    const next = put(items, L.rotate(it));
    const res = check(next);
    if (!res.ok) { say(why(res), true); return; }
    commit(next);
  }
  function nudge(dx, dy) {
    const it = selected && find(selected);
    if (!it || (isWall(it) && !dx)) return;
    const next = put(items, { ...it, tx: it.tx + dx, ty: isWall(it) ? 0 : it.ty + dy });
    const res = check(next);
    if (!res.ok) { say(why(res), true); return; }
    commit(next);
  }
  function undoLast() {
    const prev = undo.pop();
    if (!prev) return;
    items = prev.items; resetFlag = prev.resetFlag; wallet = prev.wallet;
    if (selected && !find(selected)) selected = null;
    apply();
  }
  function reset() {
    const classic = L.repair(L.scene(null, ids(), office.theme, office.progress || 0).items, ids().length);
    if (!classic) { say(t("ui.layout.err.cannotEdit"), true); return; }
    const same = JSON.stringify(classic) === JSON.stringify(L.scene(null, ids(), office.theme, office.progress || 0).items);
    let w = wallet; // what you have placed and the office did not start with goes to the depot (a piece you took down or sold stays gone)
    const inClassic = new Set(classic.map((x) => x.id));
    for (const it of items) if (!inClassic.has(it.id)) w = M.discard(w, it, effKey(it), starters.has(it.id)).wallet;
    const back = classic.filter((x) => !w.gone.includes(x.id));
    commit(back, true, w);
    resetFlag = same && w.gone.length === wallet.gone.length && back.length === classic.length;
    selected = null;
    refreshButtons();
    say(t("ui.layout.resetDone"));
  }

  // ---------- pointer ----------
  const at = (ev) => { const p = office.toLogical(ev); return { x: p.x, y: p.y, tx: Math.floor(p.x / TILE_PX), ty: Math.floor(p.y / TILE_PX) }; };
  // the piece under the pointer: the front-most one, counting the part that rises above its tiles (a fridge, a shelf, a monitor)
  function hitItem(p) {
    const depth = (it) => it.ty + (L.TYPES[it.type].sort || 0);
    for (const it of items.slice().sort((a, c) => depth(c) - depth(a) || items.indexOf(c) - items.indexOf(a))) {
      const up = L.TYPES[it.type].up || 0;
      for (const [x, y] of L.tilesOf(it)) if (p.x >= x * TILE_PX && p.x < (x + 1) * TILE_PX && p.y >= y * TILE_PX - up && p.y < (y + 1) * TILE_PX) return it;
    }
    return null;
  }
  canvas.addEventListener("pointerdown", (ev) => {
    if (!active || comparing) return;
    if (pending) { ev.preventDefault(); return; } // (answer the question first)
    if (placing) { // a click places the piece (Shift keeps going); any other button lets go of it
      if (ev.button !== 0) { stopPlacing(); ev.preventDefault(); return; }
      const g = ghostAt(hover = at(ev));
      ghost = g;
      if (g.res.ok) {
        const keep = ev.shiftKey, key = placing.key, paid = M.info(key).price > 0 && M.inDepot(wallet, key) === 0;
        if (paid) propose(g.item, keep, "click"); // asks first; a yes puts it there
        else {
          if (!keep) stopPlacing(true); // (quietly: what placing says must stay on the message line)
          const done = buyAndPlace(g.item);
          if (keep) { if (done && M.canAfford(wallet, key)) ghost = null; else stopPlacing(true); }
        }
      } else say(why(g.res), true);
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    const p = at(ev), it = hitItem(p);
    selected = it ? it.id : null;
    drag = it ? { id: it.id, orig: { ...it }, grab: [p.tx - it.tx, p.ty - it.ty], moved: false, sx: ev.clientX, sy: ev.clientY, last: "" } : null;
    if (drag) { try { canvas.setPointerCapture(ev.pointerId); } catch {} }
    ghost = null;
    refreshButtons();
    ev.preventDefault();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!active || comparing) return;
    const p = at(ev);
    hover = { tx: p.tx, ty: p.ty };
    if (pending) return;
    if (placing) { // the piece being placed follows the pointer
      ghost = ghostAt(p);
      canvas.style.cursor = ghost.res.ok ? "copy" : "not-allowed";
      say(ghost.res.ok ? t("ui.market.placing", { name: pieceName(placing.key) }) : why(ghost.res), !ghost.res.ok);
      return;
    }
    if (!drag) { canvas.style.cursor = hitItem(p) ? "grab" : "default"; return; }
    if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) return;
    drag.moved = true;
    office.editorDim = drag.id;
    const cand = { ...drag.orig, tx: p.tx - drag.grab[0], ty: isWall(drag.orig) ? 0 : p.ty - drag.grab[1] }; // (wall decor slides along the wall)
    const k = cand.tx + "," + cand.ty;
    if (k !== drag.last) { drag.last = k; ghost = { item: cand, res: check(put(items, cand)) }; }
    canvas.style.cursor = ghost.res.ok ? "grabbing" : "not-allowed";
    say(ghost.res.ok ? "" : why(ghost.res), !ghost.res.ok);
  });
  const release = (ev, cancelled) => {
    if (!active || !drag) return;
    const d = drag, g = ghost;
    drag = null; ghost = null; office.editorDim = null;
    try { canvas.releasePointerCapture(ev.pointerId); } catch {}
    canvas.style.cursor = "default";
    if (!cancelled && d.moved && g) {
      const moved = g.item.tx !== d.orig.tx || g.item.ty !== d.orig.ty;
      if (g.res.ok && moved) { commit(put(items, g.item)); return; }
      if (!g.res.ok) { refreshButtons(); say(why(g.res), true); return; }
    }
    refreshButtons();
  };
  canvas.addEventListener("pointerup", (ev) => release(ev, false));
  canvas.addEventListener("pointercancel", (ev) => release(ev, true));
  canvas.addEventListener("pointerleave", () => { hover = null; if (placing) ghost = null; });
  canvas.addEventListener("contextmenu", (ev) => { if (active && placing) { ev.preventDefault(); stopPlacing(); } });

  document.addEventListener("keydown", (ev) => {
    if (!active) return;
    const tag = (ev.target && ev.target.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || ev.target.isContentEditable) return;
    if (document.querySelector(".modal:not([hidden])")) return;
    const mod = ev.metaKey || ev.ctrlKey, k = ev.key;
    if (window.marketShop && window.marketShop.isOpen()) return; // (the shop has the keys while it is open)
    if ((k === "m" || k === "M") && !mod && window.marketShop) { window.marketShop.open(); ev.preventDefault(); return; }
    if ((k === "c" || k === "C") && !mod) { compare(true); ev.preventDefault(); return; }
    if (comparing) { ev.preventDefault(); return; }
    if (pending) { // waiting for a yes: Enter buys, Esc changes its mind
      if (k === "Enter") confirmPending(); else if (k === "Escape") cancelPending();
      ev.preventDefault();
      return;
    }
    if (placing) { // placing a piece: Enter puts it in the best free spot, R turns it, Esc lets go
      if (k === "Escape") stopPlacing();
      else if (k === "Enter") add(placing.key);
      else if ((k === "r" || k === "R") && !mod) rotatePlacing();
      else return;
      ev.preventDefault();
      return;
    }
    if (k === "Escape") { if (drag) { release(ev, true); } else if (selected) { selected = null; refreshButtons(); } else return; }
    else if (k === "Delete" || k === "Backspace") remove();
    else if ((k === "r" || k === "R") && !mod) rotate();
    else if ((k === "d" || k === "D") && mod) copy();
    else if ((k === "z" || k === "Z") && mod) undoLast();
    else if (k.startsWith("Arrow") && !mod) nudge(k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0, k === "ArrowUp" ? -1 : k === "ArrowDown" ? 1 : 0);
    else return;
    ev.preventDefault();
  });

  // ---------- drawing over the office (called from Office.draw while editing) ----------
  const tileFill = (b, tiles, col) => { b.fillStyle = col; for (const [x, y] of tiles) b.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX); };
  const frame = (b, tiles, col) => {
    b.fillStyle = col;
    const set = new Set(tiles.map(([x, y]) => x + "," + y));
    for (const [x, y] of tiles) {
      const px = x * TILE_PX, py = y * TILE_PX;
      if (!set.has(x + "," + (y - 1))) b.fillRect(px, py, TILE_PX, 2);
      if (!set.has(x + "," + (y + 1))) b.fillRect(px, py + TILE_PX - 2, TILE_PX, 2);
      if (!set.has(x - 1 + "," + y)) b.fillRect(px, py, 2, TILE_PX);
      if (!set.has(x + 1 + "," + y)) b.fillRect(px + TILE_PX - 2, py, 2, TILE_PX);
    }
  };
  function drawGhost(b, t, it, ok) {
    b.save();
    b.globalAlpha = 0.8;
    if (isWall(it)) {
      if (typeof WALL_ART !== "undefined" && WALL_ART[it.type]) WALL_ART[it.type](b, t, it.tx * TILE_PX);
    } else if (it.type === "rug") {
      drawRug(b, it.skin || office.theme, it.tx, it.ty);
    } else if (it.type === "desk") {
      const feet = (it.ty + 1) * TILE_PX;
      drawChair(b, it.tx * TILE_PX, feet);
      drawDesk(b, deskStub({ tx: it.tx, ty: it.ty }), t);
    } else {
      const list = [];
      itemDecor(office.theme, it, list);
      for (const d of list) d.draw(b, t);
    }
    b.restore();
    const tiles = L.tilesOf(it);
    tileFill(b, tiles, ok ? "rgba(74,222,128,.32)" : "rgba(248,113,113,.42)");
    frame(b, tiles, ok ? "#4ade80" : "#f87171");
  }
  function draw(b, t) {
    if (office.theme !== editTheme) { queueMicrotask(() => { if (active && office.theme !== editTheme) { toast(tr("ui.layout.themeChanged")); cancel(); } }); return; } // (the wall decor belongs to the theme)
    b.save();
    if (comparing) { // the saved office is on screen: label it and skip the editing overlays
      const text = tr("ui.layout.savedLabel");
      b.font = "bold 10px monospace"; b.textAlign = "center"; b.textBaseline = "middle";
      const w = Math.ceil(b.measureText(text).width) + 20;
      b.fillStyle = "rgba(20,21,28,.85)"; b.fillRect(480 - w / 2, 70, w, 18);
      b.fillStyle = "#ffd166"; b.fillText(text, 480, 79);
      b.restore();
      return;
    }
    // the tile grid, on the floor only
    b.fillStyle = "rgba(255,255,255,.11)";
    for (const [x, y] of L.floorTiles()) { b.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, 1); b.fillRect(x * TILE_PX, y * TILE_PX, 1, TILE_PX); }
    // where people go: a dot on every hangout spot (and a tick on the tile they step in from)
    for (const s of office.spots) {
      b.fillStyle = "rgba(255,209,102,.85)"; b.fillRect(s.tx * TILE_PX + 14, s.ty * TILE_PX + 14, 4, 4);
      if (s.via) { b.fillStyle = "rgba(255,209,102,.4)"; b.fillRect(s.via[0] * TILE_PX + 15, s.via[1] * TILE_PX + 15, 2, 2); }
    }
    // whose desk is whose
    b.font = "bold 8px monospace"; b.textAlign = "center"; b.textBaseline = "middle";
    for (const d of office.scene.build.desks) {
      const e = office.emps.find((x) => x.seat.desk === d.id);
      const text = e ? String(e.name || "").split(/\s+/)[0] : "";
      if (!text) continue;
      const w = Math.min(TILE_PX * 3 - 6, Math.ceil(b.measureText(text).width) + 8), cx = d.tx * TILE_PX + 16, cy = (d.ty + 1) * TILE_PX + 10;
      b.fillStyle = "rgba(20,21,28,.82)"; b.fillRect(cx - w / 2, cy - 6, w, 12);
      b.fillStyle = e.color || "#ffd166"; b.fillRect(cx - w / 2, cy - 6, 2, 12);
      b.fillStyle = "#f5f0e6"; b.fillText(text, cx + 1, cy + 0.5, w - 6);
    }
    const it = selected && find(selected);
    if (it && !(drag && drag.moved)) frame(b, L.tilesOf(it), "#ffd166");
    if (ghost) drawGhost(b, t, ghost.item, ghost.res.ok);
    else if (hover && !drag) {
      const hit = L.floorTiles().some(([x, y]) => x === hover.tx && y === hover.ty);
      if (hit) { b.fillStyle = "rgba(255,255,255,.08)"; b.fillRect(hover.tx * TILE_PX, hover.ty * TILE_PX, TILE_PX, TILE_PX); }
    }
    drawFx(b);
    b.restore();
  }

  document.addEventListener("keyup", (ev) => { if (comparing && (ev.key === "c" || ev.key === "C")) compare(false); });
  window.addEventListener("blur", () => compare(false));

  // ---------- open / close ----------
  function open() {
    if (active) return;
    if (typeof isOnline === "function" && !isOnline()) { toast(t("ui.toast.noConnection")); return; }
    if (typeof closeChat === "function") closeChat();
    const start = office.scene.items;
    const fixed = L.repair(start, ids().length);
    if (!fixed) { toast(t("ui.layout.err.cannotEdit")); return; }
    base = cur().layout || null;
    editTheme = office.theme;
    starters = new Set(L.scene(null, ids(), office.theme, office.progress || 0).items.map((x) => x.id));
    items = fixed; startJson = JSON.stringify(start); undo = []; selected = null; drag = null; ghost = null; resetFlag = false; saving = false;
    if (window.marketCoins) window.marketCoins.sync(); // (what finished work has earned so far is in the wallet before the draft copies it)
    const claimed = M.claim(M.load(state.office), office.progress || 0, items); // the pieces finished work unlocked are yours (not a change to save)
    wallet = claimed.wallet; walletStart = JSON.stringify(wallet); placing = null; clearPending(); fx = []; paintMute(); M.setDeals(M.pickDeals(M.catalog(office.theme, hasSkin), M.today()));
    active = true;
    office.editing = true;
    office.editorDraw = draw;
    document.body.classList.add("layout-editing");
    btn.classList.add("active");
    bar.hidden = false;
    refreshButtons();
    renderMarket();
    if (claimed.gave.length) say(t("ui.market.rewardsIn", { n: claimed.gave.length }));
    if (JSON.stringify(fixed) !== startJson) { office.applyLayout(L.toDoc(fixed, true)); say(t("ui.layout.repaired")); }
    requestAnimationFrame(() => office.fit());
    setTimeout(() => { if (active) office.fit(); }, 320); // (the stage makes room for the market over .25s)
  }
  // silent = leaving because the office on screen changes: nothing to put back
  function close(silent = false) {
    if (!active) return;
    if (window.marketShop) window.marketShop.close(); // (the shop is part of editing)
    comparing = false; active = false; drag = null; ghost = null; hover = null; placing = null; clearPending(); endCardDrag();
    if (window.marketCoins) window.marketCoins.sync(); // earnings that arrived while editing
    office.editing = false; office.editorDraw = null; office.editorDim = null;
    document.body.classList.remove("layout-editing");
    btn.classList.remove("active");
    canvas.style.cursor = "";
    bar.hidden = true;
    if (!silent) office.applyLayout(cur().layout || null);
    requestAnimationFrame(() => office.fit());
    setTimeout(() => { if (!active) office.fit(); }, 320);
  }
  function cancel(silent = false) { close(silent); }
  async function save() {
    if (!active || saving) return;
    const withDesks = L.ensureDesks(items, ids()).items; // colleagues hired meanwhile
    const res = check(withDesks);
    if (!res.ok) { say(why(res) || t("ui.layout.err.cannotEdit"), true); return; }
    if (!dirty()) { close(); return; }
    saving = true; refreshButtons();
    try {
      if (layoutDirty()) {
        const out = await api("PUT", officeApi("/layout"), { layout: resetFlag ? null : L.toDoc(withDesks, true) });
        cur().layout = out.layout ?? null;
      }
      M.save(state.office, M.prune(wallet, withDesks.map((i) => i.id))); // (only after the layout is safe: a failed save keeps the coins)
      toast(t("ui.layout.saved"));
      saving = false;
      close();
    } catch (err) {
      saving = false; refreshButtons();
      say(t("ui.layout.err.saveFailed", { message: err.message }), true);
    }
  }

  q("lbUndo").onclick = undoLast;
  q("lbRotate").onclick = rotate;
  q("lbCopy").onclick = copy;
  q("lbDelete").onclick = remove;
  q("lbSell").onclick = () => sellItemNow(selected && find(selected));
  const cmp = q("lbCompare");
  cmp.onpointerdown = (ev) => { compare(true); try { cmp.setPointerCapture(ev.pointerId); } catch {} };
  cmp.onpointerup = () => compare(false);
  cmp.onpointercancel = () => compare(false);
  cmp.onkeydown = (ev) => { if (ev.key === " " || ev.key === "Enter") { compare(true); ev.preventDefault(); } };
  cmp.onkeyup = (ev) => { if (ev.key === " " || ev.key === "Enter") compare(false); };
  q("lbReset").onclick = reset;
  q("lbCancel").onclick = () => cancel();
  q("lbSave").onclick = save;
  btn.onclick = () => {
    if (!active) open();
    else if (!dirty() || confirm(t("ui.layout.discard"))) cancel();
  };
  window.addEventListener("resize", () => { if (active) office.fit(); });
  stage.addEventListener("transitionend", (ev) => { if (ev.target === stage && /^padding/.test(ev.propertyName)) office.fit(); }); // (the stage made room for the market / took it back)

  return {
    get active() { return active; },
    get items() { return items; },
    // what the shop (web/shop.js) needs: the draft's wallet and pieces, names, thumbnails, and the actions
    api: {
      M, hasSkin, pieceName, effKey, placedCount, sfx, soundOn, paintMute,
      get wallet() { return wallet; }, get items() { return items; }, get theme() { return office.theme; }, get active() { return active; },
      thumb: (i) => renderItemThumb(office.theme, i.type, i.skin || undefined),
      buy: buyToDepot, hang: hangAmbient, takeDown: takeDownAmbient, sell: sellOne, sellPlaced, showPlaced, placedOf, undo: () => undoLast(), canUndo: () => undo.length > 0,
      tryIt: (key) => startPlacing(key), place: (key) => add(key),
      toggleSound() { try { localStorage.setItem("po.market.mute", soundOn() ? "1" : "0"); } catch {} paintMute(); sfx("place"); },
      subscribe: (fn) => { listeners.push(fn); },
    },
    open, cancel, save, add, remove, copy, rotate, undo: undoLast, commit, startPlacing, stopPlacing, get wallet() { return wallet; }, get placing() { return placing; },
    // for the ?debug panel: a random valid edit / back to the classic layout, applied to this browser only
    select(id) { selected = id; refreshButtons(); },
  };
})();
