// The furniture market's economy: what a piece costs, how rare it is, the wallet (coins, the depot of pieces you own but have not placed,
// and `gone`: the ids of pieces the office started with that you took down or sold). Everything you have is yours to keep in the depot or
// sell, the pieces the office started with included; "back to default" restores the office's own pieces except the ones in `gone`, so
// selling a starter piece and getting it back for free again is not possible.
// Everything any theme has is for sale in every office. A floor piece or rug is sold per look: the key "sofa@gothic" is the gothic sofa
// (a Throne), "rug@dream" the dream rug; a plain key ("sofa") is the piece that follows the office's theme (what the office started with).
// Wall pieces carry their theme in their type ("gothic_torch"). Pure logic, no drawing and no DOM: the browser loads it as a classic script
// (window.POMarket), the tests load the very same file. The wallet lives in this browser (localStorage, one per office).
(() => {
  const L = globalThis.POLayout;
  const START_COINS = 1000;   // a generous start; coins are earned by finished work later
  const REFUND = 0.8;         // selling a piece from the depot pays this share of its price
  const SKIN_MARKUP = 1.25;   // another theme's look costs a quarter more than the classic one
  const MAX_COINS = 1e9, MAX_STACK = 999, MAX_BOUGHT = 400, MAX_GONE = 600;
  const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
  const RARITIES = ["common", "rare", "legendary"];
  const CATEGORIES = ["kitchen", "office", "lounge", "decor", "wall"];

  // floor pieces: type -> [category, rarity, price]. Desks are free, never themed and never stored: every colleague needs one.
  const FLOOR = {
    desk: ["office", "common", 0],
    plant: ["decor", "common", 12], bin: ["decor", "common", 8], rug: ["decor", "rare", 80],
    stool: ["kitchen", "common", 15], roundTable: ["kitchen", "rare", 60], counter: ["kitchen", "rare", 120], fridge: ["kitchen", "rare", 150],
    coffeeStation: ["kitchen", "rare", 110], cooler: ["kitchen", "rare", 85],
    meetingTable: ["office", "rare", 220], meetingChair: ["office", "common", 25], printer: ["office", "rare", 140], cabinets: ["office", "rare", 60],
    boxes: ["office", "common", 20], bookshelf: ["office", "rare", 70],
    sofa: ["lounge", "rare", 90], coffeeTable: ["lounge", "common", 35], lamp: ["lounge", "common", 30],
  };
  // The legendary ones: a theme's signature pieces (wall decor, a few looks of furniture, two rugs).
  const LEGENDARY = new Set([
    "default_tv", "football_scoreboard", "football_trophies", "fashion_mirror", "fashion_atelier", "gothic_chandelier", "gothic_portrait", "gothic_glass",
    "music_onair", "music_counter", "travel_map", "travel_departures", "dream_eye", "dream_constellation", "dream_sky",
    "progress_espresso", "progress_trophies", "progress_neon",
    "sofa@gothic", "cooler@gothic", "printer@football", "lamp@football", "fridge@fashion", "lamp@fashion", "roundTable@music", "meetingTable@music",
    "fridge@travel", "lamp@travel", "fridge@dream", "coffeeStation@dream", "rug@gothic", "rug@dream",
  ]);
  const WALL_PRICE = { common: 15, rare: 60, legendary: 400 };
  const LEGENDARY_PRICE = 400;
  const isTheme = (x) => L.THEMES.includes(x);
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // The market key of a piece in the layout: its look pinned ("sofa@gothic"), or the plain type when it just follows the theme.
  const keyOf = (item) => (item.skin && !L.TYPES[item.type].wall ? item.type + "@" + item.skin : item.type);
  // What a key is: {key, type, skin, category, rarity, price, wall, ambient, group} or null. `group` = the theme it belongs to
  // ("rewards" for the pieces finished work unlocks; null for a plain key: it follows the office).
  function baseInfo(key) {
    if (typeof key !== "string") return null;
    const at = key.indexOf("@");
    const type = at < 0 ? key : key.slice(0, at), skin = at < 0 ? null : key.slice(at + 1);
    if (skin !== null && (!isTheme(skin) || !hasOwn(FLOOR, type) || type === "desk")) return null;
    if (hasOwn(FLOOR, type)) {
      const [category, base, price0] = FLOOR[type];
      const legend = LEGENDARY.has(key);
      const price = legend ? LEGENDARY_PRICE : skin && skin !== "default" ? Math.round(price0 * SKIN_MARKUP) : price0;
      return { key, type, skin, category, rarity: legend ? "legendary" : base, price, wall: false, ambient: false, group: skin };
    }
    if (skin !== null || !hasOwn(L.TYPES, type)) return null;
    const T = L.TYPES[type];
    if (!T.wall) return null;
    const rarity = LEGENDARY.has(type) ? "legendary" : T.wall.w >= 2 || T.wall.ambient ? "rare" : "common";
    return { key, type, skin: null, category: "wall", rarity, price: WALL_PRICE[rarity], wall: true, ambient: T.wall.ambient, group: T.wall.theme === "progress" ? "rewards" : T.wall.theme };
  }
  // Today's deals: a few pieces cost a fifth less. `info` shows the price you pay (`was` = the usual one); selling always pays a share of the
  // usual price, so a deal is never a way to make coins.
  const DEAL_OFF = 0.2;
  let dealMap = new Map();
  function info(key) {
    const i = baseInfo(key);
    if (!i || !dealMap.has(key)) return i;
    return { ...i, price: Math.max(1, Math.round(i.price * (1 - DEAL_OFF))), was: i.price, deal: true };
  }
  const sellPrice = (key) => { const i = baseInfo(key); return i ? Math.floor(i.price * REFUND) : 0; };
  const stored = (key) => { const i = baseInfo(key); return !!i && i.price > 0; }; // a piece that goes to the depot when taken down
  const setDeals = (keys) => { dealMap = new Map((keys || []).filter((k) => baseInfo(k) && baseInfo(k).price > 0).map((k) => [k, true])); };
  const dealKeys = () => [...dealMap.keys()];
  const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // Three deals for a day (one common, one rare, one legendary), the same for everybody that day: a seeded pick from the catalogue.
  function pickDeals(cat, day) {
    let h = 2166136261;
    for (const ch of String(day)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const rnd = () => { h = (h + 0x6d2b79f5) | 0; let x = Math.imul(h ^ (h >>> 15), 1 | h); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const out = [];
    for (const rarity of RARITIES) {
      const pool = cat.map((i) => baseInfo(i.key)).filter((i) => i && i.rarity === rarity && i.price > 0 && !i.ambient);
      if (pool.length) out.push(pool[Math.floor(rnd() * pool.length)].key);
    }
    return out;
  }
  // How much of each theme's collection is yours: `ownedKeys` = market keys of what you have (placed or in the depot).
  function collections(cat, ownedKeys) {
    const out = new Map();
    for (const i of cat) {
      if (i.group === null || i.price === 0) continue;
      const c = out.get(i.group) || { group: i.group, total: 0, owned: 0 };
      c.total++;
      if (ownedKeys.has(i.key)) c.owned++;
      out.set(i.group, c);
    }
    return [...out.values()];
  }

  // Everything for sale, for an office of this theme: every look of every floor piece (hasSkin(theme, type) says whether a theme draws
  // that piece its own way; the others would just repeat the classic one) and every theme's wall decor.
  function catalog(theme, hasSkin = () => true) {
    const out = [];
    for (const type of L.TYPE_ORDER) {
      if (type === "desk") { out.push(info("desk")); continue; }
      for (const skin of L.THEMES) if (skin === "default" || hasSkin(skin, type)) out.push(info(type + "@" + skin));
    }
    for (const group of Object.keys(L.WALL)) for (const t of L.wallOrder(group)) out.push(info(t));
    return out.filter(Boolean);
  }
  // Is this look what the office shows for this piece anyway? (the classic look stands in wherever a theme has none of its own)
  const isOwnLook = (i, theme, hasSkin) => !!i && (i.group === null || i.group === theme || (!i.wall && i.skin === "default" && !hasSkin(theme, i.type)));

  // ---------- the wallet (never mutated: every operation returns a new one) ----------
  const newWallet = () => ({ v: 1, coins: START_COINS, depot: {}, bought: [], claimed: [], gone: [] });
  const clone = (w) => ({ v: 1, coins: w.coins, depot: { ...w.depot }, bought: [...(w.bought || [])], claimed: [...(w.claimed || [])], gone: [...(w.gone || [])] });
  function sanitize(raw) {
    const w = newWallet();
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== 1) return w;
    if (Number.isInteger(raw.coins) && raw.coins >= 0) w.coins = Math.min(raw.coins, MAX_COINS);
    if (raw.depot && typeof raw.depot === "object" && !Array.isArray(raw.depot)) {
      for (const [key, n] of Object.entries(raw.depot)) if (stored(key) && Number.isInteger(n) && n > 0) w.depot[key] = Math.min(n, MAX_STACK);
    }
    if (Array.isArray(raw.bought)) w.bought = [...new Set(raw.bought.filter((id) => typeof id === "string" && ID_RE.test(id)))].slice(0, MAX_BOUGHT);
    if (Array.isArray(raw.gone)) w.gone = [...new Set(raw.gone.filter((id) => typeof id === "string" && ID_RE.test(id)))].slice(0, MAX_GONE);
    if (Array.isArray(raw.claimed)) w.claimed = [...new Set(raw.claimed.filter((n) => Number.isInteger(n) && n >= 1 && n <= L.PROGRESS_ORDER.length))];
    return w;
  }
  const inDepot = (w, key) => w.depot[key] || 0;
  const canAfford = (w, key) => { const i = info(key); return !!i && (i.price === 0 || inDepot(w, key) > 0 || w.coins >= i.price); };
  // Get one piece to place: from the depot when there is one (free), otherwise for its price. {ok, wallet, paid, fromDepot} or {ok:false, reason, price}.
  function acquire(w, key) {
    const i = info(key);
    if (!i) return { ok: false, reason: "unknown" };
    const out = clone(w);
    if (i.price === 0) return { ok: true, wallet: out, paid: 0, fromDepot: false };
    if (inDepot(w, key) > 0) { out.depot[key] -= 1; if (!out.depot[key]) delete out.depot[key]; return { ok: true, wallet: out, paid: 0, fromDepot: true }; }
    if (w.coins < i.price) return { ok: false, reason: "coins", price: i.price };
    out.coins -= i.price;
    return { ok: true, wallet: out, paid: i.price, fromDepot: false };
  }
  // Buy one piece into the depot without placing it (the market's "buy" button). {ok, wallet, paid} or {ok:false, reason, price}.
  function purchase(w, key, n = 1) {
    const i = info(key);
    n = Math.max(1, Math.min(MAX_STACK, n | 0));
    if (!i || i.price === 0) return { ok: false, reason: "unknown" };
    if (w.coins < i.price * n) return { ok: false, reason: "coins", price: i.price * n };
    const out = clone(w);
    out.coins -= i.price * n;
    out.depot[key] = Math.min(MAX_STACK, inDepot(w, key) + n);
    return { ok: true, wallet: out, paid: i.price * n };
  }
  // The piece just placed (id) was bought or taken from the depot: it can go back to the depot.
  function own(w, id) {
    const out = clone(w);
    if (typeof id === "string" && ID_RE.test(id) && !out.bought.includes(id) && out.bought.length < MAX_BOUGHT) out.bought.push(id);
    return out;
  }
  // A placed piece is taken down: into the depot (a desk just goes away: every colleague needs one). `key` = what the piece looks like now
  // (a piece that follows the theme is kept in the depot as the look it wore); `starter` = it is one of the office's own pieces, so
  // "back to default" must not bring it back. {wallet, stashed}
  function discard(w, item, key = keyOf(item), starter = false) {
    const out = clone(w);
    const i = out.bought.indexOf(item.id);
    if (i >= 0) out.bought.splice(i, 1);
    if (!stored(key)) return { wallet: out, stashed: false };
    if (starter && !out.gone.includes(item.id) && out.gone.length < MAX_GONE) out.gone.push(item.id);
    out.depot[key] = Math.min(MAX_STACK, inDepot(w, key) + 1);
    return { wallet: out, stashed: true };
  }
  // Sell a placed piece: it leaves the layout and pays its share of the usual price. {ok, wallet, gain}
  function sellItem(w, item, key = keyOf(item), starter = false) {
    const d = discard(w, item, key, starter);
    if (!d.stashed) return { ok: false, reason: "free" };
    const r = sell(d.wallet, key);
    return r.ok ? { ok: true, wallet: r.wallet, gain: r.gain } : { ok: false, reason: "none" };
  }
  // forget bought ids of pieces that are no longer in the layout
  function prune(w, ids) {
    const keep = new Set(ids), out = clone(w);
    out.bought = out.bought.filter((id) => keep.has(id));
    return out;
  }
  function sell(w, key) {
    if (inDepot(w, key) < 1) return { ok: false, reason: "none" };
    const out = clone(w);
    out.depot[key] -= 1; if (!out.depot[key]) delete out.depot[key];
    const gain = sellPrice(key);
    out.coins = Math.min(MAX_COINS, out.coins + gain);
    return { ok: true, wallet: out, gain };
  }
  function earn(w, coins) {
    const out = clone(w);
    if (Number.isInteger(coins) && coins > 0) out.coins = Math.min(MAX_COINS, out.coins + coins);
    return out;
  }
  // Finished work unlocks the pieces in POLayout.PROGRESS_ORDER, one by one. Each unlock is claimed once: a piece already hanging in the
  // office (shown at once when the decor is not stored) becomes yours (it can go to the depot), one that is not goes to the depot free.
  // `items` = the layout's pieces. {wallet, gave: [type ...]}
  function claim(w, unlocked, items) {
    let out = clone(w);
    const gave = [];
    for (let n = 1; n <= Math.min(unlocked | 0, L.PROGRESS_ORDER.length); n++) {
      if (out.claimed.includes(n)) continue;
      out.claimed.push(n);
      const type = "progress_" + L.PROGRESS_ORDER[n - 1], hung = items.find((it) => it.type === type);
      if (hung) out = own(out, hung.id);
      else { out.depot[type] = Math.min(MAX_STACK, inDepot(out, type) + 1); gave.push(type); }
    }
    return { wallet: out, gave };
  }
  const depotCount = (w) => Object.values(w.depot).reduce((a, n) => a + n, 0);

  // ---------- storage: this browser only ----------
  const storeKey = (officeId) => "po.market." + String(officeId || "main");
  function load(officeId) {
    try { const raw = globalThis.localStorage && globalThis.localStorage.getItem(storeKey(officeId)); return sanitize(raw ? JSON.parse(raw) : null); } catch { return newWallet(); }
  }
  function save(officeId, w) { try { globalThis.localStorage && globalThis.localStorage.setItem(storeKey(officeId), JSON.stringify(sanitize(w))); } catch { /* private window, quota: the wallet just does not persist */ } }

  globalThis.POMarket = { START_COINS, REFUND, RARITIES, CATEGORIES, FLOOR, WALL_PRICE, keyOf, info, sellPrice, stored, catalog, collections, isOwnLook, setDeals, dealKeys, pickDeals, today, DEAL_OFF, newWallet, sanitize, inDepot, canAfford, acquire, purchase, own, discard, sellItem, prune, sell, earn, claim, depotCount, load, save };
})();
