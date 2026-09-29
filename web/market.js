// The furniture market's economy: what a piece costs, how rare it is, the wallet (coins, the depot of pieces you own but have not placed,
// and which placed pieces you bought: only those can be taken down into the depot and sold, so the pieces the office started with
// cannot be sold, restored with "back to default" and sold again).
// Pure logic, no drawing and no DOM: the browser loads it as a classic script (window.POMarket), the tests load the very same file.
// The wallet lives in this browser (localStorage, one per office); nothing here is checked by the server.
(() => {
  const L = globalThis.POLayout;
  const START_COINS = 1000;   // a generous start; coins are earned by finished work later
  const REFUND = 0.8;         // selling a piece from the depot pays this share of its price
  const MAX_COINS = 1e9, MAX_STACK = 999, MAX_BOUGHT = 400;
  const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
  const RARITIES = ["common", "rare", "legendary"];
  const CATEGORIES = ["kitchen", "office", "lounge", "decor", "wall"];

  // floor pieces: type -> [category, rarity, price]. Desks are free and never stored: every colleague needs one.
  const FLOOR = {
    desk: ["office", "common", 0],
    plant: ["decor", "common", 12], bin: ["decor", "common", 8],
    stool: ["kitchen", "common", 15], roundTable: ["kitchen", "rare", 60], counter: ["kitchen", "rare", 120], fridge: ["kitchen", "rare", 150],
    coffeeStation: ["kitchen", "rare", 110], cooler: ["kitchen", "rare", 85],
    meetingTable: ["office", "rare", 220], meetingChair: ["office", "common", 25], printer: ["office", "rare", 140], cabinets: ["office", "rare", 60],
    boxes: ["office", "common", 20], bookshelf: ["office", "rare", 70],
    sofa: ["lounge", "rare", 90], coffeeTable: ["lounge", "common", 35], lamp: ["lounge", "common", 30],
  };
  // Wall decor is each theme's own, so the legendary pieces are the theme's signature ones (and only sold in that theme's office).
  const LEGENDARY = new Set([
    "default_tv", "football_scoreboard", "football_trophies", "fashion_mirror", "fashion_atelier", "gothic_chandelier", "gothic_portrait",
    "music_onair", "music_counter", "travel_map", "travel_departures", "dream_eye", "dream_constellation",
  ]);
  const WALL_PRICE = { common: 15, rare: 60, legendary: 400 };

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function info(type) {
    if (typeof type !== "string") return null;
    if (hasOwn(FLOOR, type)) { const [category, rarity, price] = FLOOR[type]; return { type, category, rarity, price, wall: false, theme: null }; }
    const T = hasOwn(L.TYPES, type) ? L.TYPES[type] : null;
    if (T && T.wall) {
      const rarity = LEGENDARY.has(type) ? "legendary" : T.wall.w >= 2 ? "rare" : "common";
      return { type, category: "wall", rarity, price: WALL_PRICE[rarity], wall: true, theme: T.wall.theme };
    }
    return null;
  }
  const sellPrice = (type) => { const i = info(type); return i ? Math.floor(i.price * REFUND) : 0; };
  const stored = (type) => { const i = info(type); return !!i && i.price > 0; }; // a piece that goes to the depot when taken down

  // What the market sells in an office of this theme: the floor pieces (skinned by the theme) and the theme's wall decor.
  const catalog = (theme) => [...L.TYPE_ORDER, ...L.wallOrder(theme)].map(info).filter(Boolean);

  // ---------- the wallet (never mutated: every operation returns a new one) ----------
  const newWallet = () => ({ v: 1, coins: START_COINS, depot: {}, bought: [] });
  const clone = (w) => ({ v: 1, coins: w.coins, depot: { ...w.depot }, bought: [...(w.bought || [])] });
  function sanitize(raw) {
    const w = newWallet();
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== 1) return w;
    if (Number.isInteger(raw.coins) && raw.coins >= 0) w.coins = Math.min(raw.coins, MAX_COINS);
    if (raw.depot && typeof raw.depot === "object" && !Array.isArray(raw.depot)) {
      for (const [type, n] of Object.entries(raw.depot)) if (stored(type) && Number.isInteger(n) && n > 0) w.depot[type] = Math.min(n, MAX_STACK);
    }
    if (Array.isArray(raw.bought)) w.bought = [...new Set(raw.bought.filter((id) => typeof id === "string" && ID_RE.test(id)))].slice(0, MAX_BOUGHT);
    return w;
  }
  const inDepot = (w, type) => w.depot[type] || 0;
  const canAfford = (w, type) => { const i = info(type); return !!i && (i.price === 0 || inDepot(w, type) > 0 || w.coins >= i.price); };
  // Get one piece to place: from the depot when there is one (free), otherwise for its price. {ok, wallet, paid, fromDepot} or {ok:false, reason, price}.
  function acquire(w, type) {
    const i = info(type);
    if (!i) return { ok: false, reason: "unknown" };
    const out = clone(w);
    if (i.price === 0) return { ok: true, wallet: out, paid: 0, fromDepot: false };
    if (inDepot(w, type) > 0) { out.depot[type] -= 1; if (!out.depot[type]) delete out.depot[type]; return { ok: true, wallet: out, paid: 0, fromDepot: true }; }
    if (w.coins < i.price) return { ok: false, reason: "coins", price: i.price };
    out.coins -= i.price;
    return { ok: true, wallet: out, paid: i.price, fromDepot: false };
  }
  // The piece just placed (id) was bought or taken from the depot: it can go back to the depot.
  function own(w, id) {
    const out = clone(w);
    if (typeof id === "string" && ID_RE.test(id) && !out.bought.includes(id) && out.bought.length < MAX_BOUGHT) out.bought.push(id);
    return out;
  }
  // A placed piece is taken down. One you bought goes to the depot; one the office started with (or a desk) just goes away.
  // {wallet, stashed}
  function discard(w, item) {
    const out = clone(w);
    const i = out.bought.indexOf(item.id);
    if (i < 0) return { wallet: out, stashed: false };
    out.bought.splice(i, 1);
    if (!stored(item.type)) return { wallet: out, stashed: false };
    out.depot[item.type] = Math.min(MAX_STACK, inDepot(w, item.type) + 1);
    return { wallet: out, stashed: true };
  }
  // forget bought ids of pieces that are no longer in the layout
  function prune(w, ids) {
    const keep = new Set(ids), out = clone(w);
    out.bought = out.bought.filter((id) => keep.has(id));
    return out;
  }
  function sell(w, type) {
    if (inDepot(w, type) < 1) return { ok: false, reason: "none" };
    const out = clone(w);
    out.depot[type] -= 1; if (!out.depot[type]) delete out.depot[type];
    const gain = sellPrice(type);
    out.coins = Math.min(MAX_COINS, out.coins + gain);
    return { ok: true, wallet: out, gain };
  }
  function earn(w, coins) {
    const out = clone(w);
    if (Number.isInteger(coins) && coins > 0) out.coins = Math.min(MAX_COINS, out.coins + coins);
    return out;
  }
  const depotCount = (w) => Object.values(w.depot).reduce((a, n) => a + n, 0);

  // ---------- storage: this browser only ----------
  const keyOf = (officeId) => "po.market." + String(officeId || "main");
  function load(officeId) {
    try { const raw = globalThis.localStorage && globalThis.localStorage.getItem(keyOf(officeId)); return sanitize(raw ? JSON.parse(raw) : null); } catch { return newWallet(); }
  }
  function save(officeId, w) { try { globalThis.localStorage && globalThis.localStorage.setItem(keyOf(officeId), JSON.stringify(sanitize(w))); } catch { /* private window, quota: the wallet just does not persist */ } }

  globalThis.POMarket = { START_COINS, REFUND, RARITIES, CATEGORIES, FLOOR, WALL_PRICE, info, sellPrice, stored, catalog, newWallet, sanitize, inDepot, canAfford, acquire, own, discard, prune, sell, earn, depotCount, load, save };
})();
