// Captures what the OLD hard-coded office layout produced (buildStaticFor / SPOTS / MEETING_SPOTS / deskLayout / event tiles)
// into scripts/fixtures/layout-default.json. Run it against the pre-refactor web/office.js (commit 118ef40 or earlier):
//   git show 118ef40:web/office.js > /tmp/old-office.js && node scripts/capture-layout-fixture.mjs /tmp/old-office.js
// scripts/test-layout.mjs then proves the data-driven layout reproduces exactly this output.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { loadOffice, ROOT } from "./lib/office-harness.mjs";

const src = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "web/office.js");
const h = loadOffice({ files: [] });
vm.runInContext(fs.readFileSync(src, "utf8"), h.ctx, { filename: src });
const J = (code) => JSON.parse(JSON.stringify(h.run(code)));
const themes = J("THEME_NAMES");
const out = { source: path.basename(src), themes: {}, spots: J("SPOTS"), meetingSpots: J("MEETING_SPOTS"), events: { kitchen: J("KITCHEN_TILES"), printer: J("PRINTER_TILES") }, desks: {} };
for (const th of themes) {
  const st = h.run(`buildStaticFor(${JSON.stringify(th)})`);
  out.themes[th] = {
    blocked: [...st.blocked].sort(),
    doors: [...st.doors].sort(),
    decor: st.decor.map((d) => ({ y: d.y, h: h.hashDraw(d.draw) })),
  };
}
// seats and the full blocked set (static + the row under every seated colleague) for 0..12 colleagues, as setEmployees builds them
for (let n = 0; n <= 12; n++) {
  const seats = [];
  if (n) {
    const { cols, rows } = J(`deskLayout(${n})`);
    for (let i = 0; i < n; i++) seats.push({ tx: cols[i % cols.length], ty: rows[Math.floor(i / cols.length)] });
  }
  const blocked = new Set(out.themes.default.blocked);
  for (const s of seats) for (let dx = -1; dx <= 1; dx++) blocked.add(`${s.tx + dx},${s.ty + 1}`);
  out.desks[n] = { seats, blocked: [...blocked].sort() };
}
const file = path.join(ROOT, "scripts/fixtures/layout-default.json");
fs.writeFileSync(file, JSON.stringify(out) + "\n");
console.log("fixture written:", path.relative(ROOT, file), Object.keys(out.themes).length, "themes,", out.spots.length, "spots,", out.themes.default.decor.length, "decor entries");
