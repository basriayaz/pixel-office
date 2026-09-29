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
}
assert.equal(M.info("desk").price, 0, "desks are free");
for (const bad of ["nope", "__proto__", "constructor", "", null, undefined, 5]) assert.equal(M.info(bad), null, `no info for ${String(bad)}`);
const legendary = allTypes.map(M.info).filter((i) => i.rarity === "legendary");
assert.ok(legendary.length >= 7 && legendary.every((i) => i.wall), "legendary pieces are wall decor");
for (const th of Object.keys(L.WALL)) assert.ok(legendary.some((i) => i.theme === th), `${th}: has a legendary signature piece`);
assert.ok(legendary.every((i) => i.price > Math.max(...allTypes.map(M.info).filter((x) => x.rarity === "rare").map((x) => x.price)) * 1.5), "and they are expensive");
for (const th of Object.keys(L.WALL)) {
  const cat = M.catalog(th);
  assert.equal(cat.length, L.TYPE_ORDER.length + L.wallOrder(th).length);
  assert.ok(cat.filter((i) => i.wall).every((i) => i.theme === th), `${th}: only its own wall decor`);
  assert.deepEqual(new Set(cat.map((i) => i.category)).size, M.CATEGORIES.length, `${th}: every category has something`);
}
assert.equal(M.catalog("nope").filter((i) => i.wall).length, 0, "an unknown theme sells no wall decor");

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
// a piece the office started with is not stored, so it cannot be sold (and restored by "back to default", and sold again)
dd = M.discard(w, { id: "fridge", type: "fridge" });
assert.ok(!dd.stashed && M.inDepot(dd.wallet, "fridge") === 0 && dd.wallet.coins === w.coins);
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
for (const type of allTypes) assert.ok(M.sellPrice(type) <= M.info(type).price * 0.8 + 1e-9);
// too poor
const poor = { v: 1, coins: 10, depot: {}, bought: [] };
r = M.acquire(poor, "fridge");
assert.equal(r.ok, false); assert.equal(r.reason, "coins"); assert.equal(r.price, M.info("fridge").price);
assert.equal(M.canAfford(poor, "fridge"), false); assert.equal(M.canAfford(poor, "bin"), true); assert.equal(M.canAfford(poor, "desk"), true);
assert.equal(M.acquire(poor, "nope").ok, false);
// earning
assert.equal(M.earn(poor, 25).coins, 35);
for (const bad of [-5, 0, 1.5, NaN, "9", null]) assert.equal(M.earn(poor, bad).coins, 10, `earn ignores ${bad}`);
assert.equal(M.earn({ v: 1, coins: 1e9, depot: {}, bought: [] }, 5).coins, 1e9, "capped");
// random buying / selling never makes a negative wallet and never creates coins
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
let cur = { v: 1, coins: 500, depot: {}, bought: [] }, spentNet = 0, serial = 0;
const placed = [];
for (let n = 0; n < 4000; n++) {
  const type = allTypes[Math.floor(rnd() * allTypes.length)], op = rnd();
  if (op < 0.35) { const a = M.acquire(cur, type); if (a.ok) { spentNet += a.paid; cur = M.own(a.wallet, "p" + ++serial); placed.push({ id: "p" + serial, type }); } }
  else if (op < 0.65) { if (placed.length) { const [it] = placed.splice(Math.floor(rnd() * placed.length), 1); cur = M.discard(cur, it).wallet; } }
  else { const a = M.sell(cur, type); if (a.ok) { spentNet -= a.gain; cur = a.wallet; } }
  assert.ok(cur.coins >= 0 && Number.isInteger(cur.coins), "coins stay a non-negative integer");
  for (const [t, c] of Object.entries(cur.depot)) assert.ok(c > 0 && M.stored(t));
}
assert.equal(cur.coins, 500 - spentNet, "coins only move by what was paid and refunded");
assert.ok(cur.coins <= 500, "buying and selling never makes coins");

// ---------- storage ----------
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } };
assert.deepEqual(M.load("main"), M.newWallet(), "nothing stored: a fresh wallet");
M.save("main", w);
assert.deepEqual(M.load("main"), w, "saved and read back");
assert.deepEqual(M.load("other"), M.newWallet(), "one wallet per office");
for (const junk of ["{oops", "null", "[]", "5", JSON.stringify({ v: 2, coins: 9 }), JSON.stringify({ v: 1, coins: -5, depot: { sofa: -1, nope: 3, desk: 4, __proto__: { x: 1 }, plant: 1.5 } })]) {
  mem.set("po.market.main", junk);
  const got = M.load("main");
  assert.ok(got.coins >= 0 && Number.isInteger(got.coins), `junk ${junk.slice(0, 20)}: sane coins`);
  assert.deepEqual(got.depot, {}, `junk ${junk.slice(0, 20)}: empty depot`);
}
mem.set("po.market.main", JSON.stringify({ v: 1, coins: 1e12, depot: { sofa: 100000 } }));
assert.deepEqual(M.load("main"), { v: 1, coins: 1e9, depot: { sofa: 999 }, bought: [] }, "huge numbers are capped");
mem.set("po.market.main", JSON.stringify({ v: 1, coins: 5, depot: {}, bought: ["ok1", "ok1", "not valid", 5, null, "__proto__x"] }));
assert.deepEqual(M.load("main").bought, ["ok1"], "only valid, unique ids of bought pieces");
globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
assert.deepEqual(M.load("main"), M.newWallet(), "storage blocked: a fresh wallet, no crash");
assert.doesNotThrow(() => M.save("main", w));
delete globalThis.localStorage;
console.log("market ok:", allTypes.length, "pieces,", legendary.length, "legendary");
