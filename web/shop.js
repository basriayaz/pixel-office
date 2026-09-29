// The market shop: a full-screen store opened from the layout editor (the 🛒 in the top bar, or M). Goods stand on shelves with price tags,
// today's deals and each theme's collection come first, and a counter on the right shows the piece you picked: a big preview, what it is,
// and what you can do with it (try it in the office, buy it into the depot, sell it back). The wallet, pieces and actions are the editor's
// (layoutEditor.api): buying is part of the editor's draft, Save keeps it.
const marketShop = (() => {
  const M = POMarket, L = POLayout;
  const AISLES = ["all", "mine", ...M.CATEGORIES, "depot"];
  const AISLE_ICON = { all: "🏪", mine: "🎒", kitchen: "🍳", office: "💼", lounge: "🛋️", decor: "🌿", wall: "🖼️", depot: "📦" };
  const aisleName = (id) => t(id === "mine" ? "ui.shop.mine" : "ui.market.tabs." + id);
  const RARITY_RANK = { legendary: 3, rare: 2, common: 1 };
  const GROUPS = [...L.THEMES, "rewards"];
  const E = () => layoutEditor.api;
  let root = null, open = false, confirmTimer = 0, lastCoins = null;
  const st = { aisle: "all", group: "all", q: "", sort: "picks", afford: false, fresh: false, rarity: new Set(), sel: null, confirm: null, qty: 1, note: null };

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const coin = (n) => `<i class="mk-coin"></i>${n}`;
  const groupName = (g) => (g === "rewards" ? t("ui.market.chips.rewards") : t("ui.themes." + g));

  // ---------- the data behind the shelves ----------
  const catalog = () => M.catalog(E().theme, E().hasSkin);
  // everything you have (what the office started with too), and what you got yourself: bought or unlocked (only that counts for a collection)
  function haveKeys() {
    const a = E(), out = new Set(Object.keys(a.wallet.depot));
    for (const it of a.items) out.add(a.effKey(it));
    return out;
  }
  function boughtKeys() {
    const a = E(), mine = new Set(a.wallet.bought), out = new Set(Object.keys(a.wallet.depot));
    for (const it of a.items) if (mine.has(it.id)) out.add(a.effKey(it));
    return out;
  }
  const isFree = (i) => i.price === 0;
  // everything you have: what is placed in the office (the office's own pieces too) and what waits in the depot; desks are not for sale
  const mineList = () => [...haveKeys()].map(M.info).filter((i) => i && !isFree(i));
  const countOf = (i) => (i.ambient ? (E().items.some((x) => x.type === i.type) ? 1 : 0) : E().placedOf(i.key).length) + M.inDepot(E().wallet, i.key);
  function visible(cat) {
    const a = E(), owned = haveKeys(), needle = st.q.trim().toLowerCase(), theme = a.theme;
    let list = st.aisle === "depot" ? Object.keys(a.wallet.depot).map(M.info).filter(Boolean) : st.aisle === "mine" ? mineList() : cat.filter((i) => st.aisle === "all" || i.category === st.aisle);
    if (st.group !== "all") list = list.filter((i) => i.group === st.group);
    if (needle) list = list.filter((i) => a.pieceName(i.key).toLowerCase().includes(needle) || (i.group && groupName(i.group).toLowerCase().includes(needle)));
    if (st.rarity.size) list = list.filter((i) => st.rarity.has(i.rarity));
    if (st.afford) list = list.filter((i) => M.canAfford(a.wallet, i.key));
    if (st.fresh && st.aisle !== "mine") list = list.filter((i) => !owned.has(i.key) && !isFree(i));
    const own = (i) => (M.isOwnLook(i, theme, a.hasSkin) ? 0 : 1);
    const byName = (x, y) => a.pieceName(x.key).localeCompare(a.pieceName(y.key));
    const sorters = {
      picks: (x, y) => own(x) - own(y) || RARITY_RANK[y.rarity] - RARITY_RANK[x.rarity] || x.price - y.price || byName(x, y),
      priceUp: (x, y) => x.price - y.price || byName(x, y),
      priceDown: (x, y) => y.price - x.price || byName(x, y),
      rarity: (x, y) => RARITY_RANK[y.rarity] - RARITY_RANK[x.rarity] || x.price - y.price || byName(x, y),
      name: byName,
    };
    return list.slice().sort(sorters[st.sort] || sorters.picks);
  }

  // ---------- one piece on a shelf ----------
  function item(i) {
    const a = E(), owned = haveKeys().has(i.key), inDepot = M.inDepot(a.wallet, i.key), hung = i.ambient && a.items.some((x) => x.type === i.type);
    const poor = !hung && !M.canAfford(a.wallet, i.key);
    const b = el("button", `sh-item r-${i.rarity}${st.sel === i.key ? " on" : ""}${poor && st.aisle !== "mine" ? " poor" : ""}${i.deal && st.aisle !== "mine" ? " deal" : ""}${st.aisle === "mine" ? " sell" : ""}`);
    b.type = "button"; b.dataset.key = i.key;
    const name = a.pieceName(i.key);
    const tag = st.aisle === "mine" ? `+${coin(M.sellPrice(i.key))}` : i.price === 0 ? escapeHtml(t("ui.market.free")) : i.deal ? `<s>${i.was}</s>${coin(i.price)}` : coin(i.price); // (in "my things" the tag says what it would fetch)
    b.innerHTML = `<span class="sh-stage"><img alt="" src="${a.thumb(i)}"></span><span class="sh-plank"></span>` +
      `<span class="sh-tag">${tag}</span><span class="sh-name">${escapeHtml(name)}</span>` +
      (i.deal ? `<span class="sh-deal">−${Math.round(M.DEAL_OFF * 100)}%</span>` : "") +
      `<span class="sh-own">${hung ? escapeHtml(t("ui.market.ambientOn")) : inDepot || owned ? escapeHtml(t("ui.shop.have", { n: a.placedCount(i.key) + inDepot })) : "&nbsp;"}</span>`;
    const img = b.querySelector("img");
    img.onload = () => { img.width = img.naturalWidth * 2; img.height = img.naturalHeight * 2; };
    img.draggable = false;
    b.setAttribute("aria-label", `${name}, ${t("ui.market.rarity." + i.rarity)}, ${i.price === 0 ? t("ui.market.free") : i.price}`);
    b.onclick = () => select(i.key);
    return b;
  }
  const shelf = (list) => { const g = el("div", "sh-shelf"); for (const i of list) g.appendChild(item(i)); return g; };
  const section = (title, sub, list, cls = "") => {
    const s = el("section", "sh-section " + cls);
    s.appendChild(el("h2", "sh-h", `<span>${escapeHtml(title)}</span>${sub ? `<small>${escapeHtml(sub)}</small>` : ""}`));
    s.appendChild(shelf(list));
    return s;
  };

  // ---------- the page ----------
  function build() {
    root = el("div", "shop");
    root.id = "shop"; root.hidden = true;
    root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-label", t("ui.shop.title"));
    root.innerHTML = `
      <div class="shop-awning" aria-hidden="true"></div>
      <header class="shop-top">
        <div class="shop-brand"><b>${escapeHtml(t("ui.shop.title"))}</b><span>${escapeHtml(t("ui.shop.sub"))}</span></div>
        <input class="shop-search" id="shSearch" type="search" placeholder="${escapeHtml(t("ui.shop.search"))}" aria-label="${escapeHtml(t("ui.shop.search"))}" autocomplete="off">
        <select class="shop-sort" id="shSort" aria-label="${escapeHtml(t("ui.shop.sort.label"))}">${["picks", "priceUp", "priceDown", "rarity", "name"].map((k) => `<option value="${k}">${escapeHtml(t("ui.shop.sort." + k))}</option>`).join("")}</select>
        <label class="shop-toggle"><input type="checkbox" id="shAfford"><span>${escapeHtml(t("ui.shop.afford"))}</span></label>
        <label class="shop-toggle"><input type="checkbox" id="shFresh"><span>${escapeHtml(t("ui.shop.fresh"))}</span></label>
        <span class="shop-wallet"><button class="mk-mute" id="shMute" type="button"></button><span class="mk-coins" id="shCoins"></span></span>
        <button class="btn small" id="shClose" type="button">${escapeHtml(t("ui.shop.back"))} <kbd>Esc</kbd></button>
      </header>
      <div class="shop-body">
        <nav class="shop-aisles" id="shAisles" aria-label="${escapeHtml(t("ui.shop.aisles"))}"></nav>
        <main class="shop-main" id="shMain"></main>
        <aside class="shop-counter" id="shCounter" aria-live="polite"></aside>
      </div>`;
    document.body.appendChild(root);
    const q = (id) => root.querySelector("#" + id);
    q("shSearch").oninput = (ev) => { st.q = ev.target.value; renderMain(); };
    q("shSort").onchange = (ev) => { st.sort = ev.target.value; renderMain(); };
    q("shAfford").onchange = (ev) => { st.afford = ev.target.checked; renderMain(); };
    q("shFresh").onchange = (ev) => { st.fresh = ev.target.checked; renderMain(); };
    q("shMute").onclick = () => { E().toggleSound(); renderTop(); };
    q("shClose").onclick = close;
    root.addEventListener("keydown", onKey);
    E().subscribe(() => { if (open) render(); });
  }

  function renderTop() {
    const a = E(), chip = root.querySelector("#shCoins");
    chip.innerHTML = coin(a.wallet.coins);
    if (lastCoins !== null && lastCoins !== a.wallet.coins) { // the change floats up from the coin counter
      const d = a.wallet.coins - lastCoins, f = el("span", "mk-float" + (d > 0 ? " up" : ""), (d > 0 ? "+" : "−") + Math.abs(d));
      chip.appendChild(f); chip.classList.remove("pulse"); void chip.offsetWidth; chip.classList.add("pulse");
      setTimeout(() => f.remove(), 1000);
    }
    lastCoins = a.wallet.coins;
    const m = root.querySelector("#shMute"), on = a.soundOn();
    m.textContent = on ? "🔊" : "🔇"; m.title = t(on ? "ui.market.soundOn" : "ui.market.soundOff");
  }

  function renderAisles() {
    const a = E(), host = root.querySelector("#shAisles"), cat = catalog();
    host.textContent = "";
    for (const id of AISLES) {
      const n = id === "all" ? cat.length : id === "depot" ? M.depotCount(a.wallet) : id === "mine" ? mineList().reduce((sum, i) => sum + countOf(i), 0) : cat.filter((i) => i.category === id).length;
      const b = el("button", "sh-aisle" + (st.aisle === id ? " on" : ""), `<span class="ico" aria-hidden="true">${AISLE_ICON[id]}</span><span>${escapeHtml(aisleName(id))}</span><em>${n}</em>`);
      b.type = "button";
      b.onclick = () => { st.aisle = id; renderAisles(); renderMain(); };
      host.appendChild(b);
    }
  }

  // the shop window: today's star piece, big, behind glass (a legendary deal when there is one), with the other deals on a shelf beside it
  const starOf = () => { const deals = M.dealKeys().map(M.info).filter(Boolean); return deals.find((i) => i.rarity === "legendary") || deals[0] || null; };
  function windowHero() {
    const a = E(), star = starOf();
    if (!star) return null;
    const name = a.pieceName(star.key), inDepot = M.inDepot(a.wallet, star.key);
    const sec = el("section", `sh-window r-${star.rarity}`);
    const glass = el("button", "sw-glass", `<span class="sw-stage"><img alt="" src="${a.thumb(star)}"></span><span class="sw-plank"></span>`);
    glass.type = "button"; glass.setAttribute("aria-label", name);
    const img = glass.querySelector("img");
    img.onload = () => { img.width = img.naturalWidth * 4; img.height = img.naturalHeight * 4; };
    glass.onclick = () => select(star.key);
    const info = el("div", "sw-info");
    info.innerHTML = `<span class="sw-plate">${escapeHtml(t("ui.shop.windowTitle"))}</span><h2>${escapeHtml(name)}</h2>` +
      `<p class="sw-sub r-${star.rarity}"><b>${escapeHtml(t("ui.market.rarity." + star.rarity))}</b>${star.group ? ` · ${escapeHtml(groupName(star.group))}` : ""}</p>` +
      `<p class="sw-price">${money(star.price)} <s>${star.was}</s> <em>${escapeHtml(t("ui.shop.dealToday", { p: Math.round(M.DEAL_OFF * 100) }))}</em></p>`;
    const row = el("div", "sw-acts");
    const tryB = el("button", "btn primary", escapeHtml(t(inDepot ? "ui.shop.placeDepot" : "ui.shop.tryIt")));
    tryB.type = "button"; tryB.disabled = !M.canAfford(a.wallet, star.key); tryB.onclick = () => tryIt(star.key);
    const more = el("button", "btn", escapeHtml(t("ui.shop.details"))); more.type = "button"; more.onclick = () => select(star.key);
    row.append(tryB, more); info.appendChild(row);
    const others = M.dealKeys().filter((k) => k !== star.key).map(M.info).filter(Boolean);
    sec.append(glass, info);
    if (others.length) {
      const side = el("div", "sw-side");
      side.appendChild(el("h3", "", `${escapeHtml(t("ui.shop.deals"))} <small>${escapeHtml(t("ui.shop.dealsSub", { p: Math.round(M.DEAL_OFF * 100) }))}</small>`));
      side.appendChild(shelf(others));
      sec.appendChild(side);
    }
    return sec;
  }
  // the signature pieces of every theme that are not yours yet (the ones in today's window and on deal are shown there already)
  function legends(cat) {
    const a = E(), have = haveKeys(), star = starOf();
    const list = cat.filter((i) => i.rarity === "legendary" && !have.has(i.key) && !i.deal && (!star || i.key !== star.key))
      .sort((x, y) => (M.isOwnLook(y, a.theme, a.hasSkin) ? 1 : 0) - (M.isOwnLook(x, a.theme, a.hasSkin) ? 1 : 0) || x.price - y.price).slice(0, 7);
    return list.length ? section(t("ui.shop.legends"), t("ui.shop.legendsSub"), list) : null;
  }

  function collectionsStrip(cat) {
    const cols = M.collections(cat, boughtKeys());
    const s = el("section", "sh-section sh-collections");
    s.appendChild(el("h2", "sh-h", `<span>${escapeHtml(t("ui.shop.collections"))}</span><small>${escapeHtml(t("ui.shop.collectionsSub"))}</small>`));
    const row = el("div", "sh-cols");
    for (const g of GROUPS) {
      const c = cols.find((x) => x.group === g);
      if (!c) continue;
      const pal = (L.THEMES.includes(g) && window.THEME_COLORS && window.THEME_COLORS(g)) || null;
      const done = c.owned >= c.total;
      const b = el("button", "sh-col" + (st.group === g ? " on" : "") + (done ? " done" : ""));
      b.type = "button";
      b.style.setProperty("--c1", pal ? pal[0] : "#ffd166"); b.style.setProperty("--c2", pal ? pal[1] : "#b8862b");
      const best = cat.filter((i) => i.group === g).sort((x, y) => RARITY_RANK[y.rarity] - RARITY_RANK[x.rarity] || y.price - x.price).slice(0, 3);
      const minis = best.map((i) => `<img alt="" src="${E().thumb(i)}">`).join("");
      b.innerHTML = `<span class="swatch" aria-hidden="true"></span><span class="nm">${escapeHtml(groupName(g))}</span><span class="minis" aria-hidden="true">${minis}</span><span class="cnt">${done ? "★ " : ""}${c.owned}/${c.total}</span><span class="bar"><i style="width:${Math.round((c.owned / c.total) * 100)}%"></i></span>`;
      b.title = t("ui.shop.collectionTip", { name: groupName(g), owned: c.owned, total: c.total });
      b.onclick = () => { st.group = st.group === g ? "all" : g; renderMain(); };
      row.appendChild(b);
    }
    s.appendChild(row);
    return s;
  }

  function renderMain() {
    const a = E(), host = root.querySelector("#shMain"), keep = host.scrollTop, cat = catalog();
    host.textContent = "";
    const front = st.aisle === "all" && st.group === "all" && !st.q.trim() && !st.rarity.size && !st.afford && !st.fresh;
    if (front) {
      const hero = windowHero();
      if (hero) host.appendChild(hero);
      const rare = legends(cat);
      if (rare) host.appendChild(rare);
      host.appendChild(collectionsStrip(cat));
    }
    if (st.aisle !== "depot") { // what you can narrow the shelves by: rarity, and the theme picked from the collections
      const bar = el("div", "sh-filters", `<span class="lbl">${escapeHtml(t("ui.shop.rarity"))}</span>`);
      for (const r of ["common", "rare", "legendary"]) {
        const b = el("button", `sh-rar r-${r}${st.rarity.has(r) ? " on" : ""}`, escapeHtml(t("ui.market.rarity." + r)));
        b.type = "button"; b.setAttribute("aria-pressed", st.rarity.has(r) ? "true" : "false");
        b.onclick = () => { st.rarity.has(r) ? st.rarity.delete(r) : st.rarity.add(r); renderMain(); };
        bar.appendChild(b);
      }
      if (st.group !== "all") {
        const b = el("button", "sh-clear", `${escapeHtml(t("ui.shop.showing", { name: groupName(st.group) }))} ✕`);
        b.type = "button"; b.onclick = () => { st.group = "all"; renderMain(); };
        bar.appendChild(b);
      }
      host.appendChild(bar);
    }
    const list = visible(cat);
    if (st.aisle === "mine") { // a ledger of what you own and what it would fetch
      const all = mineList(), n = all.reduce((sum, i) => sum + countOf(i), 0), worth = all.reduce((sum, i) => sum + countOf(i) * M.sellPrice(i.key), 0);
      host.appendChild(el("div", "sh-ledger", `<span><b>${n}</b> ${escapeHtml(t("ui.shop.mineCount", { n }))}</span><span>${escapeHtml(t("ui.shop.mineWorth"))} <b>${coin(worth)}</b></span><small>${escapeHtml(t("ui.shop.mineHint"))}</small>`));
    }
    if (!list.length) {
      const depotEmpty = st.aisle === "depot", mineEmpty = st.aisle === "mine" && !st.q.trim() && !st.rarity.size && st.group === "all";
      host.appendChild(el("p", "sh-empty", `<b>${escapeHtml(t(depotEmpty ? "ui.shop.emptyDepotTitle" : mineEmpty ? "ui.shop.emptyMineTitle" : "ui.shop.emptyTitle"))}</b><span>${escapeHtml(t(depotEmpty ? "ui.market.emptyDepot" : mineEmpty ? "ui.shop.emptyMineHint" : "ui.shop.emptyHint"))}</span>`));
    } else if (st.sort === "picks" && st.aisle === "all" && st.group === "all" && !st.q.trim()) {
      for (const c of M.CATEGORIES) { const part = list.filter((i) => i.category === c); if (part.length) host.appendChild(section(t("ui.market.tabs." + c), "", part)); }
    } else host.appendChild(section(st.aisle === "depot" || st.aisle === "mine" ? aisleName(st.aisle) : t("ui.shop.results"), t("ui.shop.count", { n: list.length }), list));
    host.scrollTop = keep;
    renderCounter();
  }

  // ---------- the counter: the piece you picked ----------
  const where = (i) => {
    const T = L.TYPES[i.type];
    if (T.wall) return T.wall.ambient ? t("ui.shop.whereAmbient") : t("ui.shop.whereWall", { w: T.wall.w });
    const tiles = L.tilesOf({ type: i.type, tx: 0, ty: 0 }), xs = tiles.map((q) => q[0]), ys = tiles.map((q) => q[1]);
    const w = Math.max(...xs) - Math.min(...xs) + 1, h = Math.max(...ys) - Math.min(...ys) + 1;
    return t(i.type === "rug" ? "ui.shop.whereRug" : "ui.shop.whereFloor", { w, h });
  };
  function select(key) { st.sel = key; st.confirm = null; st.qty = 1; st.note = null; clearTimeout(confirmTimer); render(); }

  const money = (n) => `<i class="mk-coin"></i>${n}`;
  // an action on the editor's draft: on success the counter says what happened (and offers to undo it)
  function run(fn, message) {
    if (!fn()) return false;
    st.note = { text: message() }; st.confirm = null; st.qty = 1; clearTimeout(confirmTimer);
    render();
    return true;
  }

  function renderCounter() {
    const a = E(), host = root.querySelector("#shCounter");
    host.textContent = "";
    const i = st.sel && M.info(st.sel);
    if (!i) { host.appendChild(el("div", "ct-empty", `<b>${escapeHtml(t("ui.shop.pickTitle"))}</b><span>${escapeHtml(t("ui.shop.pickHint"))}</span>`)); return; }
    const name = a.pieceName(i.key), inDepot = M.inDepot(a.wallet, i.key), hung = i.ambient && a.items.some((x) => x.type === i.type);
    const placed = i.ambient ? (hung ? 1 : 0) : a.placedOf(i.key).length, sells = M.stored(i.key), gain = M.sellPrice(i.key);
    const stage = el("div", `ct-stage r-${i.rarity}`, `<img alt="" src="${a.thumb(i)}">`);
    const img = stage.querySelector("img");
    img.onload = () => { img.width = img.naturalWidth * 4; img.height = img.naturalHeight * 4; };
    host.appendChild(stage);
    host.appendChild(el("h2", "ct-name", escapeHtml(name)));
    host.appendChild(el("p", `ct-sub r-${i.rarity}`, `<b>${escapeHtml(t("ui.market.rarity." + i.rarity))}</b>${i.group ? ` · ${escapeHtml(groupName(i.group))}` : ""}`));
    const price = i.price === 0 ? escapeHtml(t("ui.market.free")) : i.deal ? `${money(i.price)} <s>${i.was}</s> <em>${escapeHtml(t("ui.shop.dealToday", { p: Math.round(M.DEAL_OFF * 100) }))}</em>` : money(i.price);
    host.appendChild(el("div", "ct-price", price));
    const facts = el("dl", "ct-facts");
    const row = (k, v) => { facts.appendChild(el("dt", "", escapeHtml(k))); facts.appendChild(el("dd", "", escapeHtml(v))); };
    row(t("ui.shop.factWhere"), where(i));
    row(t("ui.shop.factHave"), i.ambient ? t(hung ? "ui.market.ambientOn" : "ui.market.ambientOff") : t("ui.market.owned", { placed, depot: inDepot }));
    if (sells) row(t("ui.shop.factSell"), t("ui.shop.sellFor", { n: gain }));
    host.appendChild(facts);

    const acts = el("div", "ct-acts");
    const btn = (cls, label, fn, disabled = false) => { const b = el("button", "btn " + cls, label); b.type = "button"; b.disabled = disabled; b.onclick = fn; acts.appendChild(b); return b; };
    const total = i.price * st.qty, canPay = a.wallet.coins >= i.price, canPayQty = a.wallet.coins >= total;
    const sellDepot = () => run(() => a.sell(i.key), () => t("ui.shop.didSell", { name, gain }));
    const sellPlaced = () => run(() => a.sellPlaced(i.key), () => t("ui.shop.didSellPlaced", { name, gain }));
    if (st.confirm === i.key) { // the second step of buying: say yes once more
      btn("primary", `${escapeHtml(i.ambient ? t("ui.shop.hangYes", { n: total }) : t("ui.shop.buyYes", { q: st.qty, n: total }))} <kbd>⏎</kbd>`, () => doConfirm(i));
      btn("", `${escapeHtml(t("ui.market.notNow"))} <kbd>Esc</kbd>`, () => { st.confirm = null; clearTimeout(confirmTimer); renderCounter(); });
    } else if (i.ambient) {
      if (hung) {
        btn("", escapeHtml(t("ui.market.takeDown")), () => run(() => a.takeDown(i.type), () => t("ui.shop.didDown", { name })));
        if (sells) btn("ghost", escapeHtml(t("ui.shop.sellPlaced", { n: gain })), sellPlaced);
      } else if (inDepot) {
        btn("primary", escapeHtml(t("ui.shop.hangFree")), () => run(() => a.hang(i.key), () => t("ui.shop.didHang", { name })));
        if (sells) btn("ghost", escapeHtml(t("ui.market.sell", { gain })), sellDepot);
      } else btn("primary", escapeHtml(t("ui.shop.hang", { n: i.price })), () => askConfirm(i), !canPay);
    } else {
      if (inDepot) btn("primary", escapeHtml(t("ui.shop.placeDepot")), () => tryIt(i.key));
      else btn("primary", escapeHtml(t("ui.shop.tryIt")), () => tryIt(i.key), !canPay);
      if (placed > 0) btn("", escapeHtml(t("ui.shop.showIt")), () => { if (a.showPlaced(i.key)) close(); });
      if (i.price > 0) {
        const qty = el("div", "ct-qty");
        qty.innerHTML = `<span>${escapeHtml(t("ui.shop.qty"))}</span><button type="button" aria-label="−" ${st.qty <= 1 ? "disabled" : ""}>−</button><output>${st.qty}</output><button type="button" aria-label="+" ${st.qty >= 9 ? "disabled" : ""}>+</button>`;
        const [minus, plus] = qty.querySelectorAll("button");
        minus.onclick = () => { st.qty = Math.max(1, st.qty - 1); renderCounter(); };
        plus.onclick = () => { st.qty = Math.min(9, st.qty + 1); renderCounter(); };
        acts.appendChild(qty);
        btn("", escapeHtml(t(st.qty > 1 ? "ui.shop.buyDepotQty" : "ui.shop.buyDepot", { q: st.qty, n: total })), () => askConfirm(i), !canPayQty);
      }
      if (inDepot && sells) btn("ghost", escapeHtml(t("ui.market.sell", { gain })), sellDepot);
      if (placed > 0 && sells) btn("ghost", escapeHtml(t("ui.shop.sellPlaced", { n: gain })), sellPlaced);
    }
    host.appendChild(acts);
    if (st.note) {
      const n = el("p", "ct-note ok", `<span>${escapeHtml(st.note.text)}</span>`);
      if (a.canUndo()) { const u = el("button", "ct-undo", escapeHtml(t("ui.shop.undo"))); u.type = "button"; u.onclick = () => { a.undo(); st.note = null; renderTop(); render(); }; n.appendChild(u); }
      host.appendChild(n);
    } else if (!canPayQty && !inDepot && i.price > 0 && !hung && st.confirm !== i.key) host.appendChild(el("p", "ct-note bad", escapeHtml(t("ui.shop.needMore", { n: total - a.wallet.coins }))));
    else host.appendChild(el("p", "ct-note", escapeHtml(t(i.ambient ? "ui.shop.noteAmbient" : inDepot ? "ui.shop.noteDepot" : placed > 0 ? "ui.shop.noteMine" : "ui.shop.noteTry"))));
  }

  function askConfirm(i) {
    st.confirm = i.key; renderCounter();
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => { if (st.confirm === i.key) { st.confirm = null; if (open) renderCounter(); } }, 6000); // (a forgotten question goes away)
  }
  function doConfirm(i) {
    clearTimeout(confirmTimer);
    const a = E(), name = a.pieceName(i.key), q = st.qty, total = i.price * q;
    if (!run(() => (i.ambient ? a.hang(i.key) : a.buy(i.key, q)), () => (i.ambient ? t("ui.shop.didHang", { name }) : t("ui.shop.didBuy", { name: name + (q > 1 ? " ×" + q : ""), n: total })))) { st.confirm = null; renderCounter(); }
  }
  function tryIt(key) { close(); E().tryIt(key); } // the ghost follows the pointer; a click places it (and asks before it charges you)

  function onKey(ev) {
    const tag = (ev.target && ev.target.tagName) || "";
    if (ev.key === "Escape") { if (st.confirm) { st.confirm = null; clearTimeout(confirmTimer); renderCounter(); } else close(); ev.preventDefault(); ev.stopPropagation(); return; }
    if (ev.key === "Enter" && st.confirm && !/^(BUTTON|INPUT|SELECT)$/.test(tag)) { const i = M.info(st.confirm); if (i) doConfirm(i); ev.preventDefault(); return; }
    if (/^Arrow(Left|Right|Up|Down)$/.test(ev.key) && ev.target && ev.target.classList && ev.target.classList.contains("sh-item")) { moveFocus(ev.target, ev.key); ev.preventDefault(); return; }
    if (ev.key === "/" && !/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) { root.querySelector("#shSearch").focus(); ev.preventDefault(); }
  }

  // arrow keys walk the shelves: left and right along a row, up and down to the nearest piece in the row above or below
  function moveFocus(cur, key) {
    const all = [...root.querySelectorAll(".sh-item")], i = all.indexOf(cur);
    if (i < 0) return;
    let next = null;
    if (key === "ArrowLeft") next = all[i - 1]; else if (key === "ArrowRight") next = all[i + 1];
    else {
      const r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, down = key === "ArrowDown";
      let best = 1e9;
      for (const o of all) {
        const q = o.getBoundingClientRect();
        if (down ? q.top <= r.top + 8 : q.top >= r.top - 8) continue;
        const score = Math.abs((down ? q.top - r.top : r.top - q.top)) * 4 + Math.abs(q.left + q.width / 2 - cx);
        if (score < best) { best = score; next = o; }
      }
    }
    if (next) { next.focus(); next.scrollIntoView({ block: "nearest" }); }
  }

  function render() { if (!root) return; renderTop(); renderAisles(); renderMain(); }

  // ---------- open / close ----------
  function openShop() {
    if (typeof layoutEditor === "undefined") return;
    if (!layoutEditor.active) layoutEditor.open();
    if (!layoutEditor.active) return; // (offline, or the editor refused)
    if (!root) build();
    open = true; root.hidden = false; lastCoins = null;
    document.body.classList.add("shop-open");
    st.confirm = null;
    if (!st.sel || !M.info(st.sel)) { const star = starOf(); st.sel = star ? star.key : null; } // (the counter is never empty: it starts with today's star)
    render();
    requestAnimationFrame(() => root.querySelector("#shSearch").focus({ preventScroll: true }));
  }
  function close() {
    if (!open) return;
    open = false; root.hidden = true;
    clearTimeout(confirmTimer);
    document.body.classList.remove("shop-open");
  }
  const shopBtn = document.getElementById("btnShop");
  if (shopBtn) shopBtn.onclick = () => (open ? close() : openShop());
  return { open: openShop, close, isOpen: () => open };
})();
window.marketShop = marketShop;
