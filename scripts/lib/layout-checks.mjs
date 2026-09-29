// Checks for web/layout.js (called by scripts/test-layout.mjs): placement validation, the schema, and a fuzz test.
import assert from "node:assert/strict";

const plant = (id, tx, ty) => ({ id, type: "plant", tx, ty, v: 1 });

export function runValidation(P) {
  const ids3 = ["a", "b", "c"];
  const base = () => P.scene(null, ids3).items;
  const move = (items, id, tx, ty) => items.map((it) => (it.id === id ? { ...it, tx, ty } : it));
  const codes = (items, o = { empCount: 3 }) => [...new Set(P.check(items, o).errors.map((e) => e.code))];
  assert.equal(P.check(base(), { empCount: 3 }).ok, true, "the classic layout is valid");

  // not on walls, doors or outside the floor
  for (const [tx, ty] of [[7, 3], [22, 8], [7, 5], [3, 9], [26, 9], [0, 0], [10, 1], [30, 3], [-1, 3], [14, 17]]) assert.ok(codes(move(base(), "fridge", tx, ty)).includes("outside"), `fridge at ${tx},${ty} is off the floor`);
  assert.ok(codes(move(base(), "sofa", 5, 12)).includes("outside"), "sofa across the wall column");
  assert.ok(codes(move(base(), "coffee", 4, 2)).includes("outside"), "counter across the wall column");
  // not on other pieces, chairs, desk seats or a desk
  assert.ok(codes(move(base(), "fridge", 2, 2)).includes("overlap"), "fridge on the counter");
  assert.ok(codes(move(base(), "bin", 1, 6)).includes("overlap"), "bin on a stool");
  assert.ok(codes(move(base(), "bin", 11, 5)).includes("overlap"), "bin on a desk seat");
  assert.ok(codes(move(base(), "bin", 10, 6)).includes("overlap"), "bin on a desk");
  // closing a doorway (both tiles in front of it) or sealing the entrance is refused
  assert.ok(codes([...base(), plant("p1", 6, 5), plant("p2", 6, 6)]).includes("door"), "kitchen door blocked from inside");
  assert.ok(codes([...base(), plant("p1", 8, 12), plant("p2", 8, 13)]).includes("door"), "lounge door blocked from the office side");
  assert.ok(codes([...base(), plant("p1", 3, 8), plant("p2", 4, 8)]).includes("door"), "kitchen / lounge door blocked from above");
  assert.ok(P.check([...base(), plant("p1", 6, 5)], { empCount: 3 }).ok, "one free tile in front of a door is enough");
  assert.ok(codes([...base(), plant("p1", 13, 16), plant("p2", 15, 16), plant("p3", 14, 15)]).includes("unreachable"), "entrance walled in: nothing reachable");
  assert.ok(codes(move(base(), "plant5", 14, 16)).includes("entrance"), "furniture on the entrance mat");
  // standing on the tile a spot needs
  assert.ok(codes(move(base(), "plant4", 3, 3)).includes("spot"), "plant on the coffee spot");
  assert.ok(codes(move(base(), "bin", 20, 2)).includes("spot"), "bin on the window spot");
  // cutting an area off
  const cut = [...base(), ...[10, 11, 12, 13, 14, 15, 16].map((y) => plant("w" + y, 6, y))].filter((it) => it.id !== "plant2");
  assert.ok(!P.check(cut, { empCount: 3 }).ok, "a hedge across the lounge is refused");

  // desks: assigned ones stay, spare ones may go; every colleague keeps a desk
  const it3 = base();
  assert.equal(P.canDelete(it3, "desk0", ids3).reason, "assigned", "a desk somebody sits at cannot be deleted");
  const spare = P.findPlace(it3, { id: P.nextId(it3, "desk"), type: "desk" }, [14, 9]);
  assert.ok(spare, "room for a spare desk");
  const it4 = [...it3, spare];
  assert.equal(P.canDelete(it4, spare.id, ids3).ok, true, "a spare desk can be deleted");
  assert.equal(P.canDelete(it4, "desk1", ids3).reason, "assigned");
  assert.equal(P.check(it3, { empCount: 4 }).errors.some((e) => e.code === "desks"), true, "fewer desks than colleagues is an error");
  // a hire gets a desk automatically (a spare desk is used first); nothing fits -> reported
  const more = [...ids3, "d", "e"];
  const hired = P.ensureDesks(it3, more);
  assert.equal(hired.items.filter((i) => i.type === "desk").length, 5, "two more desks for two hires");
  assert.ok(P.check(hired.items, { empCount: 5 }).ok, "and they are valid");
  assert.deepEqual([...P.assignDesks(hired.items, more).map.keys()].sort(), ["a", "b", "c", "d", "e"]);
  const spared = P.ensureDesks(it4, [...ids3, "d"]);
  assert.equal(spared.items.filter((i) => i.type === "desk").length, 4, "the spare desk is taken before a new one is made");
  assert.equal(spared.items.find((i) => i.id === spare.id).emp, "d", "and remembered");
  const full = [...P.defaultItems(), ...P.floorTiles(["office"]).filter(([x, y]) => !(x === 14 && y >= 15) && !(x === 15 && y === 16) && !(x === 13 && y === 16)).map(([x, y], i) => plant("q" + i, x, y))];
  const crowded = P.ensureDesks(full, ["z"]);
  assert.deepEqual(crowded.missing, ["z"], "no room left for a desk: reported, layout untouched");
  assert.equal(crowded.items.length, full.length);
  // repair: the classic layout for 11-12 colleagues puts a desk on the entrance mat
  for (const n of [10, 11, 12]) {
    const items = P.scene(null, Array.from({ length: n }, (_, i) => "e" + i)).items;
    const fixed = P.repair(items, n);
    assert.ok(fixed && P.check(fixed, { empCount: n }).ok, `${n} colleagues: repaired to a valid layout`);
  }

  // what the server accepts: the schema
  const okDoc = P.toDoc(base());
  assert.equal(P.sanitize(okDoc).ok, true);
  for (const [name, doc] of [
    ["null", null], ["array", []], ["version", { ...okDoc, v: 2 }], ["no items", { v: 1 }], ["items not array", { v: 1, items: {} }],
    ["unknown type", { v: 1, items: [{ id: "x", type: "wall", tx: 1, ty: 1 }] }],
    ["duplicate id", { v: 1, items: [plant("x", 1, 1), plant("x", 2, 2)] }],
    ["float tile", { v: 1, items: [plant("x", 1.5, 1)] }], ["huge tile", { v: 1, items: [plant("x", 99, 1)] }], ["string tile", { v: 1, items: [{ ...plant("x", 1, 1), tx: "1" }] }],
    ["bad id", { v: 1, items: [plant("x y", 1, 1)] }], ["proto id", { v: 1, items: [plant("__proto__;", 1, 1)] }],
    ["bad dir", { v: 1, items: [{ id: "s", type: "stool", tx: 1, ty: 6, dir: "sideways" }] }],
    ["too many", { v: 1, items: Array.from({ length: 151 }, (_, i) => plant("p" + i, 1, 1)) }],
    ["bad variant", { v: 1, items: [{ ...plant("x", 1, 1), v: 7 }] }], ["emp too long", { v: 1, items: [{ id: "d", type: "desk", tx: 12, ty: 5, emp: "x".repeat(81) }] }],
  ]) assert.equal(P.sanitize(doc).ok, false, `schema rejects: ${name}`);
  const cleaned = P.sanitize({ v: 1, items: [{ id: "f", type: "fridge", tx: 5, ty: 2, dir: "up", evil: "x", emp: "a" }] });
  assert.deepEqual(JSON.parse(JSON.stringify(cleaned.items)), [{ id: "f", type: "fridge", tx: 5, ty: 2 }], "unknown fields are stripped");
  console.log("layout validation ok");
}

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// An independent check (its own occupancy and its own walking search) that a layout is sound.
export function oracle(P, items, n) {
  const T = P.TYPES, occ = new Map(), fp = new Set(), softs = new Set();
  const floor = new Set(P.floorTiles().map(([x, y]) => x + "," + y));
  for (const it of items) for (const [kind, list] of [["fp", T[it.type].fp || []], ["soft", T[it.type].soft || []]]) for (const [dx, dy] of list) {
    const k = it.tx + dx + "," + (it.ty + dy);
    assert.ok(floor.has(k), `${it.id} stands on the floor (${k})`);
    assert.ok(!occ.has(k), `${it.id} overlaps ${occ.get(k)} at ${k}`);
    occ.set(k, it.id);
    (kind === "fp" ? fp : softs).add(k);
  }
  const passable = (x, y) => x >= 0 && y >= 0 && x < P.COLS && y < P.ROWS && !P.WALLS.has(x + "," + y) && !fp.has(x + "," + y) && !softs.has(x + "," + y);
  assert.ok(passable(P.ENTRANCE.tx, P.ENTRANCE.ty), "entrance free");
  const seen = new Set([P.ENTRANCE.tx + "," + P.ENTRANCE.ty]), q = [[P.ENTRANCE.tx, P.ENTRANCE.ty]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = x + dx + "," + (y + dy); if (!seen.has(k) && passable(x + dx, y + dy)) { seen.add(k); q.push([x + dx, y + dy]); } }
  }
  const b = P.build(items);
  const desks = items.filter((i) => i.type === "desk");
  assert.ok(desks.length >= n, "a desk for everybody");
  for (const d of desks) assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => seen.has(d.tx + dx + "," + (d.ty + dy))), `desk ${d.id} reachable`);
  for (const s of b.spots) if (!s.soft) assert.ok(seen.has((s.via ? s.via : [s.tx, s.ty]).join(",")), `spot ${s.key} reachable`);
  for (const g of P.DOOR_GROUPS) for (const side of [g.a, g.b]) assert.ok(side.some(([x, y]) => seen.has(x + "," + y)), "doorway open");
  for (const s of b.spots) assert.ok(!P.WALLS.has(s.tx + "," + s.ty), "spot not in a wall");
  return seen;
}

// A random valid edit (or null when this try was refused), shared by the pure fuzz and the office fuzz.
export function randomEdit(P, items, ids, rnd) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const n = ids.length;
  const op = pick(["move", "move", "move", "delete", "copy", "rotate", "add"]);
  const it = pick(items);
  let next = null;
  if (op === "move") next = items.map((x) => (x.id === it.id ? { ...x, tx: Math.floor(rnd() * P.COLS), ty: Math.floor(rnd() * P.ROWS) } : x));
  else if (op === "delete") { if (P.canDelete(items, it.id, ids).ok) next = items.filter((x) => x.id !== it.id); }
  else if (op === "copy") { const proto = { ...it, id: P.nextId(items, it.type) }; delete proto.emp; const c = P.findPlace(items, proto, [it.tx, it.ty], { empCount: n }); if (c) next = [...items, c]; }
  else if (op === "rotate") next = items.map((x) => (x.id === it.id ? P.rotate(x) : x));
  else {
    const type = pick(P.TYPE_ORDER.filter((t) => t !== "desk"));
    const c = P.findPlace(items, { id: P.nextId(items, type), type, ...(type === "plant" ? { v: 1, water: true } : {}), ...(P.DEFAULT_DIR[type] ? { dir: P.DEFAULT_DIR[type] } : {}) }, [14, 9], { empCount: n });
    if (c) next = [...items, c];
  }
  if (!next || (items.length > 60 && op !== "delete")) return null;
  return P.check(next, { empCount: n }).ok ? next : false;
}

export function runFuzz(P, seeds = 40, steps = 120) {
  let accepted = 0, refused = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const rnd = mulberry(seed);
    const n = 1 + Math.floor(rnd() * 12);
    const ids = Array.from({ length: n }, (_, i) => "e" + i);
    let items = P.repair(P.scene(null, ids).items, n);
    assert.ok(items, `seed ${seed}: classic layout for ${n} colleagues can be repaired`);
    oracle(P, items, n);
    for (let step = 0; step < steps; step++) {
      const next = randomEdit(P, items, ids, rnd);
      if (next === null) continue;
      if (next) { items = next; accepted++; oracle(P, items, n); } else refused++;
    }
    assert.equal(P.build(items).errors.length, 0, `seed ${seed}: final layout builds cleanly`);
    const { map, missing } = P.assignDesks(items, ids);
    assert.deepEqual(missing, []);
    assert.equal(new Set(map.values()).size, n, "nobody shares a desk");
  }
  console.log(`layout fuzz ok: ${accepted} valid edits applied, ${refused} invalid ones refused, every desk / spot / doorway reachable after each`);
}
