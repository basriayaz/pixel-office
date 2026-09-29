// Office layout: the data-driven furniture (web/layout.js + web/office.js) must reproduce the old hard-coded office exactly in the
// default layout, reject invalid placements, and keep every colleague and every spot reachable through random edits.
// The fixture (scripts/fixtures/layout-default.json) was captured from the pre-refactor code by scripts/capture-layout-fixture.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadOffice, ROOT } from "./lib/office-harness.mjs";

const fx = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/layout-default.json"), "utf8"));
const J = (v) => JSON.parse(JSON.stringify(v));
const spotView = (s) => { const o = { key: s.key, tx: s.tx, ty: s.ty, dir: s.dir, anim: s.anim }; if (s.via) o.via = [...s.via]; return o; };
const byKey = (a, b) => (a.key < b.key ? -1 : 1);

// ---------- 1. equivalence with the old hard-coded office ----------
const h = loadOffice();
const L = h.run("POLayout");
const themes = J(h.run("THEME_NAMES"));
assert.deepEqual(themes.sort(), Object.keys(fx.themes).sort(), "same themes");
for (const th of themes) {
  const st = h.run(`buildStaticFor(${JSON.stringify(th)})`);
  const want = fx.themes[th];
  assert.deepEqual([...st.blocked].sort(), want.blocked, `${th}: blocked tiles`);
  assert.deepEqual([...st.doors].sort(), want.doors, `${th}: doors`);
  assert.deepEqual(J(st.decor.map((d) => ({ y: d.y, h: h.hashDraw(d.draw) }))), want.decor, `${th}: decor depth order and drawing`);
}
const def = L.build(L.defaultItems());
assert.deepEqual(J(def.errors), [], "default layout builds without errors");
assert.deepEqual(J(def.spots).map(spotView).sort(byKey), J(fx.spots).sort(byKey), "spots: key, tile, facing, animation, via");
assert.deepEqual(J(def.meetingSpots).map(spotView), J(fx.meetingSpots), "meeting spots, in order (chairs first)");
assert.deepEqual(J(def.events.food[0].tiles), fx.events.kitchen, "pizza / cake tiles around the round table");
assert.deepEqual(J(def.events.printer[0].tiles), fx.events.printer, "printer jam tiles");
assert.equal(def.events.food.length + def.events.printer.length, 2);
// desks and seated blocked tiles for 0..12 colleagues
for (let n = 0; n <= 12; n++) {
  const ids = Array.from({ length: n }, (_, i) => "e" + i);
  const sc = L.scene(null, ids);
  assert.deepEqual(J(sc.build.desks).map((d) => ({ tx: d.tx, ty: d.ty })), fx.desks[n].seats, `${n} colleagues: desk seats`);
  assert.deepEqual([...sc.build.blocked].sort(), fx.desks[n].blocked, `${n} colleagues: blocked tiles`);
  assert.deepEqual(ids.map((id) => sc.build.desks.findIndex((d) => d.id === sc.assign.get(id))), ids.map((_, i) => i), `${n} colleagues: the i-th colleague sits at the i-th seat`);
  assert.deepEqual(J(sc.missing), [], `${n} colleagues: nobody without a desk`);
}
// every wall piece has its artwork, and drawing it (on any tile) works
{
  const draw = h.run("(b, t, type, x0) => WALL_ART[type](b, t, x0)");
  const fixed = h.run("(b, t, theme) => { const f = PROPS[theme] && PROPS[theme].wallFixed; if (f) f(b, t); }");
  let n = 0;
  for (const [type, T] of Object.entries(J(L.TYPES))) {
    if (!T.wall) continue;
    assert.equal(h.run(`typeof WALL_ART[${JSON.stringify(type)}]`), "function", `${type}: has artwork`);
    for (const x0 of [0, 13 * 32, (30 - T.wall.w) * 32]) assert.ok(h.hashDraw((b, t) => draw(b, t, type, x0)), `${type}: draws at ${x0}`);
    assert.notEqual(h.hashDraw((b, t) => draw(b, t, type, 0)), h.hashDraw((b, t) => draw(b, t, type, 64)), `${type}: moves with its tile`);
    n++;
  }
  assert.equal(n, Object.values(J(L.WALL)).reduce((a, x) => a + Object.keys(x).length, 0), "every catalog entry is a type");
  for (const th of themes) h.hashDraw((b, t) => fixed(b, t, th));
}
console.log("layout equivalence ok:", themes.length, "themes,", fx.spots.length, "spots,", fx.themes.default.decor.length, "decor entries, 0..12 colleagues");

// ---------- 2. validation, 3. fuzz ----------
await import(pathToFileURL(path.join(ROOT, "web/layout.js")).href);
const { runValidation, runWalls, runFuzz } = await import("./lib/layout-checks.mjs");
runValidation(globalThis.POLayout);
runWalls(globalThis.POLayout);
runFuzz(globalThis.POLayout);
const { runOffice } = await import("./lib/office-checks.mjs");
runOffice(h, globalThis.POLayout);

// ---------- 4. the server side: saved per office, checked again on the way in ----------
const distLayout = path.join(ROOT, "dist/server/layout.js");
if (fs.existsSync(distLayout)) {
  const { default: os } = await import("node:os");
  const { OfficeLayout } = await import(pathToFileURL(distLayout).href);
  const P = globalThis.POLayout;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "po-layout-"));
  const ids = ["a", "b", "c"];
  let store = new OfficeLayout(dir);
  assert.equal(store.doc, null, "no file: the classic layout");
  const good = P.toDoc(P.scene(null, ids).items.filter((i) => i.id !== "fridge"));
  const okd = store.check(good, ids);
  assert.equal(okd.ok, true);
  store.set(okd.doc);
  assert.deepEqual(J(new OfficeLayout(dir).doc), J(okd.doc), "saved and read back");
  assert.ok(fs.existsSync(path.join(dir, "layout.json")));
  // invalid input is refused with the reasons, and nothing is written
  const bad = (doc, code) => { const r = store.check(doc, ids); assert.equal(r.ok, false); if (code) assert.ok(r.codes.includes(code), `${code}: ${r.error} ${r.codes}`); };
  bad(P.toDoc(P.scene(null, ids).items.map((i) => (i.id === "sofa" ? { ...i, tx: 5 } : i))), "outside");
  bad(P.toDoc([...good.items, { id: "x", type: "plant", tx: 6, ty: 5, v: 1 }, { id: "y", type: "plant", tx: 6, ty: 6, v: 1 }]), "door");
  bad(P.toDoc(good.items.filter((i) => i.id !== "desk2")), "desks");
  bad({ v: 1, items: [{ id: "x", type: "<script>", tx: 1, ty: 1 }] });
  bad("nope"); bad(null);
  bad({ v: 1, items: Array.from({ length: 500 }, (_, i) => ({ id: "p" + i, type: "plant", tx: 1, ty: 1 })) });
  assert.deepEqual(J(new OfficeLayout(dir).doc), J(okd.doc), "refused layouts leave the saved one alone");
  // wall decor: stored per theme, checked on the way in, kept when a hire gets a desk
  const withWalls = P.toDoc(P.scene(null, ids, "gothic").items, ["gothic"]);
  const okw = store.check(withWalls, ids);
  assert.equal(okw.ok, true);
  assert.deepEqual(J(okw.doc.walls), ["gothic"], "the server keeps the list of themes");
  store.set(okw.doc);
  assert.deepEqual(J(new OfficeLayout(dir).doc), J(okw.doc), "wall decor saved and read back");
  bad(P.toDoc([...withWalls.items, { id: "gothic_clock9", type: "gothic_clock", tx: 10, ty: 0 }], ["gothic"]), "window");
  bad(P.toDoc([...withWalls.items, { id: "gothic_clock9", type: "gothic_clock", tx: 13, ty: 0 }], ["gothic"]), "wallOverlap");
  bad({ ...withWalls, walls: ["nope"] });
  assert.equal(store.ensure([...ids, "w"]), true);
  assert.deepEqual(J(store.doc.walls), ["gothic"], "a hire keeps the wall list");
  assert.equal(store.doc.items.filter((i) => i.type.startsWith("gothic_")).length, withWalls.items.filter((i) => i.type.startsWith("gothic_")).length);
  store.set(okd.doc);
  // a hire: a desk appears for them and is remembered
  assert.equal(store.ensure([...ids, "d"]), true);
  assert.equal(store.doc.items.filter((i) => i.type === "desk").length, 4);
  assert.equal(new OfficeLayout(dir).doc.items.filter((i) => i.type === "desk").length, 4, "the new desk was saved");
  assert.equal(store.ensure([...ids, "d"]), false, "nothing more to do");
  // a broken file: the classic layout, never a crash
  fs.writeFileSync(path.join(dir, "layout.json"), "{oops");
  fs.rmSync(path.join(dir, "layout.json.bak"), { force: true });
  assert.equal(new OfficeLayout(dir).doc, null);
  // a file that parses but is not a valid layout (edited by hand) is ignored
  fs.writeFileSync(path.join(dir, "layout.json"), JSON.stringify({ v: 1, items: [{ id: "f", type: "fridge", tx: 7, ty: 5 }] }));
  assert.equal(new OfficeLayout(dir).doc, null);
  store = new OfficeLayout(dir);
  store.set(okd.doc);
  store.set(null);
  assert.equal(new OfficeLayout(dir).doc, null, "reset goes back to the classic layout");
  console.log("layout server side ok");
} else console.log("(dist not built: skipping the server-side layout checks)");
