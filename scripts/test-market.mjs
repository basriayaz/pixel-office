// The furniture market (web/market.js): every piece has a price, a rarity and a category; the wallet never goes negative, refunds 80%,
// never trusts what is stored, and legendary pieces are theme-specific wall decor.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./lib/office-harness.mjs";

await import(pathToFileURL(path.join(ROOT, "web/layout.js")).href);
await import(pathToFileURL(path.join(ROOT, "web/market.js")).href);
const L = globalThis.POLayout, M = globalThis.POMarket;

// ---------- the catalog ----------
const allTypes = Object.keys(L.TYPES);
for (const type of allTypes) {
  const i = M.info(type);
  assert.ok(i, `${type}: has market info`);
  assert.ok(M.RARITIES.includes(i.rarity) && M.CATEGORIES.includes(i.category), `${type}: known rarity and category`);
  assert.ok(Number.isInteger(i.price) && i.price >= 0);
  assert.equal(i.wall, !!L.TYPES[type].wall);
  assert.equal(i.category === "wall", i.wall);
  assert.equal(i.ambient, !!(L.TYPES[type].wall && L.TYPES[type].wall.ambient));
}
assert.equal(M.info("desk").price, 0, "desks are free");
for (const bad of ["nope", "__proto__", "constructor", "", null, undefined, 5, "sofa@nope", "sofa@", "@gothic", "desk@gothic", "default_clock@gothic", "sofa@gothic@dream", "sofa@__proto__"]) assert.equal(M.info(bad), null, `no info for ${String(bad)}`);
// every look of every floor piece
const hasSkin = (th, type) => !(th === "music" && type === "stool"); // (stands in for office.js: a theme without its own art repeats the classic one)
const cat = M.catalog("gothic", hasSkin);
const keys = cat.map((i) => i.key);
assert.equal(new Set(keys).size, keys.length, "no key twice");
for (const i of cat) assert.deepEqual(M.info(i.key), i, `${i.key}: the key gives the same info back`);
for (const th of L.THEMES) assert.ok(keys.includes("sofa@" + th) && keys.includes("rug@" + th), `${th}: the sofa and the rug are for sale`);
assert.ok(!keys.includes("stool@music") && keys.includes("stool@default") && keys.includes("stool@dream"), "a look a theme does not draw itself is not repeated");
assert.ok(keys.includes("desk") && !keys.some((k) => k.startsWith("desk@")), "the desk is not themed");
for (const group of Object.keys(L.WALL)) for (const t of L.wallOrder(group)) assert.ok(keys.includes(t), `${t}: for sale in every office`);
assert.equal(cat.filter((i) => i.wall).length, allTypes.filter((t) => L.TYPES[t].wall).length, "all wall decor");
assert.deepEqual(M.catalog("dream", hasSkin).map((i) => i.key), M.catalog("football", hasSkin).map((i) => i.key), "the market is the same in every office");
const legendary = cat.filter((i) => i.rarity === "legendary");
assert.ok(legendary.length >= 20, "plenty of legendary pieces");
for (const th of L.THEMES.filter((x) => x !== "default")) assert.ok(legendary.some((i) => i.group === th && !i.wall), `${th}: a legendary look of furniture`);
for (const th of Object.keys(L.WALL).filter((g) => g !== "progress")) assert.ok(legendary.some((i) => i.group === th && i.wall), `${th}: a legendary signature piece`);
const maxRare = Math.max(...cat.filter((i) => i.rarity === "rare").map((i) => i.price));
assert.ok(legendary.every((i) => i.price > maxRare), "and they are expensive");
// a typo in the legendary list would quietly do nothing: every legendary key must be a real piece
assert.equal(legendary.length, [...new Set(legendary.map((i) => i.key))].length);
assert.ok(M.info("sofa@football").price > M.info("sofa@default").price && M.info("sofa@default").price === M.info("sofa").price, "another theme's look costs more than the classic one");
assert.equal(M.info("sofa@gothic").group, "gothic"); assert.equal(M.info("sofa").group, null); assert.equal(M.info("progress_neon").group, "rewards"); assert.equal(M.info("gothic_torch").group, "gothic");
assert.equal(M.info("rug@dream").category, "decor"); assert.equal(M.info("gothic_glass").category, "wall");
assert.equal(M.keyOf({ type: "sofa", skin: "gothic" }), "sofa@gothic"); assert.equal(M.keyOf({ type: "sofa" }), "sofa"); assert.equal(M.keyOf({ type: "gothic_torch", skin: "gothic" }), "gothic_torch");
// what the office shows anyway
assert.ok(M.isOwnLook(M.info("sofa@gothic"), "gothic", hasSkin) && !M.isOwnLook(M.info("sofa@dream"), "gothic", hasSkin));
assert.ok(M.isOwnLook(M.info("stool@default"), "music", hasSkin) && !M.isOwnLook(M.info("stool@default"), "dream", hasSkin), "the classic look stands in where a theme has none");
assert.ok(M.isOwnLook(M.info("gothic_torch"), "gothic", hasSkin) && !M.isOwnLook(M.info("gothic_torch"), "dream", hasSkin));

// ---------- the wallet ----------
const w0 = M.newWallet();
assert.equal(w0.coins, M.START_COINS);
const sofa = M.info("sofa").price;
let r = M.acquire(w0, "sofa");
assert.ok(r.ok && r.paid === sofa && r.wallet.coins === w0.coins - sofa && !r.fromDepot);
assert.equal(w0.coins, M.START_COINS, "the wallet is never mutated");
let w = r.wallet;
// taking a bought piece down stores it; placing it again is free
w = M.own(w, "sofa2");
assert.deepEqual(w.bought, ["sofa2"]);
let dd = M.discard(w, { id: "sofa2", type: "sofa" });
assert.ok(dd.stashed && M.inDepot(dd.wallet, "sofa") === 1 && dd.wallet.bought.length === 0);
w = dd.wallet;
// a piece the office started with is yours too: it goes to the depot (under the look it wore) and is remembered as gone
dd = M.discard(w, { id: "fridge", type: "fridge" }, "fridge@football", true);
assert.ok(dd.stashed && M.inDepot(dd.wallet, "fridge@football") === 1 && dd.wallet.gone.join() === "fridge" && dd.wallet.coins === w.coins, "a starter piece goes to the depot and is remembered");
assert.equal(M.discard(dd.wallet, { id: "fridge", type: "fridge" }, "fridge@football", true).wallet.gone.length, 1, "remembered once");
assert.deepEqual(M.discard(w, { id: "chair9", type: "plant" }, "plant@default", false).wallet.gone, [], "a piece that is not a starter is not remembered");
assert.ok(!M.discard(w, { id: "desk1", type: "desk" }, "desk", true).stashed && M.discard(w, { id: "desk1", type: "desk" }, "desk", true).wallet.gone.length === 0, "desks just go away");
// selling a placed piece: it pays its share of the usual price, a starter is remembered as gone, so it cannot be had again for free
const sp = M.sellItem(w, { id: "fridge", type: "fridge" }, "fridge@football", true);
assert.ok(sp.ok && sp.gain === M.sellPrice("fridge@football") && sp.wallet.coins === w.coins + sp.gain && M.inDepot(sp.wallet, "fridge@football") === 0 && sp.wallet.gone.join() === "fridge");
assert.ok(sp.gain < M.info("fridge@football").price, "selling pays less than buying");
assert.equal(M.sellItem(w, { id: "desk1", type: "desk" }, "desk", true).ok, false, "a desk is not for sale");
assert.equal(M.sellItem(w, { id: "x", type: "nope" }, "nope", false).ok, false);
assert.equal(M.own(w, "bad id!").bought.length, 0, "only valid ids");
assert.deepEqual(M.prune(M.own(M.own(w, "a1"), "b2"), ["b2", "c3"]).bought, ["b2"], "ids of pieces that are gone are forgotten");
r = M.acquire(w, "sofa");
assert.ok(r.ok && r.paid === 0 && r.fromDepot && r.wallet.coins === w.coins && M.inDepot(r.wallet, "sofa") === 0, "from the depot: free");
// desks: free, never stored
assert.ok(M.acquire(w, "desk").ok && M.acquire(w, "desk").paid === 0);
assert.equal(M.inDepot(M.discard(M.own(w, "desk9"), { id: "desk9", type: "desk" }).wallet, "desk"), 0, "a desk taken down does not go to the depot");
// selling pays 80% (rounded down), and only what is in the depot
const s = M.sell(w, "sofa");
assert.ok(s.ok && s.gain === Math.floor(sofa * 0.8) && s.wallet.coins === w.coins + s.gain && M.inDepot(s.wallet, "sofa") === 0);
assert.equal(M.sell(s.wallet, "sofa").ok, false, "nothing left to sell");
assert.ok(M.sellPrice("sofa") < M.info("sofa").price, "you never gain by buying and selling");
for (const type of keys) assert.ok(M.sellPrice(type) <= M.info(type).price * 0.8 + 1e-9);
// too poor
const poor = { v: 1, coins: 10, depot: {}, bought: [], claimed: [], gone: [] };
r = M.acquire(poor, "fridge");
assert.equal(r.ok, false); assert.equal(r.reason, "coins"); assert.equal(r.price, M.info("fridge").price);
assert.equal(M.canAfford(poor, "fridge"), false); assert.equal(M.canAfford(poor, "bin"), true); assert.equal(M.canAfford(poor, "desk"), true);
assert.equal(M.acquire(poor, "nope").ok, false);
// earning
assert.equal(M.earn(poor, 25).coins, 35);
for (const bad of [-5, 0, 1.5, NaN, "9", null]) assert.equal(M.earn(poor, bad).coins, 10, `earn ignores ${bad}`);
assert.equal(M.earn({ v: 1, coins: 1e9, depot: {}, bought: [], claimed: [], gone: [] }, 5).coins, 1e9, "capped");
// random buying / selling never makes a negative wallet and never creates coins
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
let cur = { v: 1, coins: 500, depot: {}, bought: [], claimed: [], gone: [] }, spentNet = 0, serial = 0;
const placed = [];
for (let n = 0; n < 4000; n++) {
  const type = keys[Math.floor(rnd() * keys.length)], op = rnd();
  if (op < 0.35) { const a = M.acquire(cur, type); if (a.ok) { spentNet += a.paid; cur = M.own(a.wallet, "p" + ++serial); placed.push({ id: "p" + serial, type: M.info(type).type, ...(M.info(type).skin ? { skin: M.info(type).skin } : {}) }); } }
  else if (op < 0.65) { if (placed.length) { const [it] = placed.splice(Math.floor(rnd() * placed.length), 1); cur = M.discard(cur, it).wallet; } }
  else { const a = M.sell(cur, type); if (a.ok) { spentNet -= a.gain; cur = a.wallet; } }
  assert.ok(cur.coins >= 0 && Number.isInteger(cur.coins), "coins stay a non-negative integer");
  for (const [t, c] of Object.entries(cur.depot)) assert.ok(c > 0 && M.stored(t));
}
assert.equal(cur.coins, 500 - spentNet, "coins only move by what was paid and refunded");
assert.ok(cur.coins <= 500, "buying and selling never makes coins");

// a bought piece in another look goes back to the depot under that look
let sk = M.own(M.newWallet(), "sofa3");
sk = M.discard(sk, { id: "sofa3", type: "sofa", skin: "gothic" });
assert.ok(sk.stashed && M.inDepot(sk.wallet, "sofa@gothic") === 1 && M.inDepot(sk.wallet, "sofa") === 0, "the look is kept in the depot");
assert.equal(M.sell(sk.wallet, "sofa@gothic").gain, Math.floor(M.info("sofa@gothic").price * 0.8));
assert.ok(M.acquire(sk.wallet, "sofa@gothic").fromDepot && !M.acquire(sk.wallet, "sofa@dream").fromDepot, "and only that look comes back");
// finished work unlocks pieces, each claimed once
let cw = M.newWallet();
let cl = M.claim(cw, 2, [{ id: "progress_poster", type: "progress_poster" }]);
assert.deepEqual(cl.wallet.claimed, [1, 2]);
assert.deepEqual(cl.gave, ["progress_plant"], "the one already hanging is yours, the other goes to the depot");
assert.equal(M.inDepot(cl.wallet, "progress_plant"), 1);
assert.deepEqual(cl.wallet.bought, ["progress_poster"], "and the hanging one can be taken down into the depot");
assert.deepEqual(M.claim(cl.wallet, 2, []).gave, [], "claimed once");
assert.deepEqual(M.claim(cl.wallet, 5, []).gave, ["progress_espresso", "progress_trophies", "progress_neon"]);
assert.deepEqual(M.claim(cw, 0, []).wallet.claimed, []); assert.deepEqual(M.claim(cw, 99, []).wallet.claimed, [1, 2, 3, 4, 5]);
assert.equal(cl.wallet.coins, cw.coins, "claiming costs and pays nothing");

// ---------- today's deals, buying into the depot, collections ----------
const day1 = "2026-10-01", day2 = "2026-10-02";
const d1 = M.pickDeals(cat, day1);
assert.equal(d1.length, 3, "three deals a day");
assert.deepEqual(d1.map((k) => M.info(k).rarity), ["common", "rare", "legendary"], "one of each rarity");
assert.deepEqual(M.pickDeals(cat, day1), d1, "the same for everybody that day");
let differ = 0; for (let n = 1; n <= 28; n++) if (M.pickDeals(cat, `2026-11-${String(n).padStart(2, "0")}`).join() !== d1.join()) differ++;
assert.ok(differ >= 26, "the deals rotate");
assert.ok(d1.every((k) => M.info(k).price > 0 && !M.info(k).ambient && !k.startsWith("desk")));
const plain = M.info(d1[2]).price;
M.setDeals(d1);
const dl = M.info(d1[2]);
assert.ok(dl.deal && dl.was === plain && dl.price === Math.round(plain * 0.8), "a deal costs a fifth less and remembers the usual price");
assert.equal(M.info(cat.find((i) => !d1.includes(i.key) && i.price > 0).key).deal, undefined, "the others are as usual");
assert.deepEqual(M.dealKeys(), d1);
for (const k of d1) { // buying on a deal and selling never makes coins, and neither does a deal for the rest of the day
  const w0 = { v: 1, coins: 5000, depot: {}, bought: [], claimed: [], gone: [] };
  const bought = M.purchase(w0, k);
  assert.ok(bought.ok && bought.paid === M.info(k).price && bought.wallet.coins === 5000 - bought.paid && M.inDepot(bought.wallet, k) === 1, `${k}: bought into the depot`);
  const back = M.sell(bought.wallet, k);
  assert.ok(back.gain <= bought.paid, `${k}: selling never pays more than the deal price`);
}
assert.ok(M.acquire({ v: 1, coins: dl.price, depot: {}, bought: [], claimed: [], gone: [] }, d1[2]).ok, "and you can pay it with exactly that");
assert.equal(M.acquire({ v: 1, coins: dl.price - 1, depot: {}, bought: [], claimed: [], gone: [] }, d1[2]).ok, false);
M.setDeals(["nope", "desk", "sofa@gothic"]);
assert.deepEqual(M.dealKeys(), ["sofa@gothic"], "only real, paid pieces can be on a deal");
M.setDeals([]);
assert.equal(M.info(d1[2]).deal, undefined);
assert.match(M.today(new Date(2026, 9, 1)), /^2026-10-01$/);
// purchase: pays and stores, refuses when poor, never for desks / unknown keys
const pw = { v: 1, coins: 100, depot: {}, bought: [], claimed: [], gone: [] };
assert.equal(M.purchase(pw, "sofa").wallet.coins, 100 - M.info("sofa").price);
assert.equal(M.purchase(pw, "fridge").ok, false); assert.equal(M.purchase(pw, "fridge").reason, "coins");
assert.equal(M.purchase(pw, "desk").ok, false); assert.equal(M.purchase(pw, "nope").ok, false);
assert.equal(M.inDepot(M.purchase(M.purchase(pw, "bin").wallet, "bin").wallet, "bin"), 2, "buying twice keeps two");
const many = M.purchase(pw, "bin", 5);
assert.ok(many.ok && many.paid === 5 * M.info("bin").price && M.inDepot(many.wallet, "bin") === 5 && many.wallet.coins === 100 - many.paid, "buying several at once");
assert.equal(M.purchase(pw, "bin", 50).ok, false, "and only what you can pay for");
assert.equal(M.purchase(pw, "bin", 0).paid, M.info("bin").price, "at least one");
// collections: how much of each theme is yours
const cols = M.collections(cat, new Set(["sofa@gothic", "gothic_torch", "rug@gothic", "sofa@dream"]));
const gothic = cols.find((c) => c.group === "gothic"), dream = cols.find((c) => c.group === "dream");
assert.equal(gothic.owned, 3); assert.equal(dream.owned, 1);
assert.ok(gothic.total > 10 && gothic.total === cat.filter((i) => i.group === "gothic").length, "the total is everything of that theme");
assert.ok(cols.some((c) => c.group === "rewards" && c.total === 5), "the rewards are a collection too");
assert.ok(!cols.some((c) => c.group === null), "pieces that follow the theme belong to no collection");

// ---------- storage ----------
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } };
assert.deepEqual(M.load("main"), M.newWallet(), "nothing stored: a fresh wallet");
M.save("main", w);
assert.deepEqual(M.load("main"), w, "saved and read back");
assert.deepEqual(M.load("other"), M.newWallet(), "one wallet per office");
for (const junk of ["{oops", "null", "[]", "5", JSON.stringify({ v: 2, coins: 9 }), JSON.stringify({ v: 1, coins: -5, depot: { sofa: -1, nope: 3, desk: 4, __proto__: { x: 1 }, plant: 1.5, "sofa@nope": 2, "desk@gothic": 1 }, claimed: [0, 9, "1", 1.5] })]) {
  mem.set("po.market.main", junk);
  const got = M.load("main");
  assert.ok(got.coins >= 0 && Number.isInteger(got.coins), `junk ${junk.slice(0, 20)}: sane coins`);
  assert.deepEqual(got.depot, {}, `junk ${junk.slice(0, 20)}: empty depot`);
  assert.deepEqual(got.claimed, [], `junk ${junk.slice(0, 20)}: nothing claimed`);
  assert.deepEqual(got.gone, [], `junk ${junk.slice(0, 20)}: nothing gone`);
}
mem.set("po.market.main", JSON.stringify({ v: 1, coins: 1e12, depot: { sofa: 100000 } }));
assert.deepEqual(M.load("main"), { v: 1, coins: 1e9, depot: { sofa: 999 }, bought: [], claimed: [], gone: [] }, "huge numbers are capped");
mem.set("po.market.main", JSON.stringify({ v: 1, coins: 5, depot: {}, bought: ["ok1", "ok1", "not valid", 5, null, "__proto__x"], gone: ["g1", "g1", "bad id", 7] }));
assert.deepEqual(M.load("main").gone, ["g1"], "only valid, unique ids of gone pieces");
assert.deepEqual(M.load("main").bought, ["ok1"], "only valid, unique ids of bought pieces");
globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
assert.deepEqual(M.load("main"), M.newWallet(), "storage blocked: a fresh wallet, no crash");
assert.doesNotThrow(() => M.save("main", w));
delete globalThis.localStorage;
console.log("market ok:", keys.length, "pieces for sale,", legendary.length, "legendary");
