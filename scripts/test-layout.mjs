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
console.log("layout equivalence ok:", themes.length, "themes,", fx.spots.length, "spots,", fx.themes.default.decor.length, "decor entries, 0..12 colleagues");
