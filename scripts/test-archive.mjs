// Reading the chat archive back page by page (Store.readArchive / archiveCount). Runs against dist/ (npm run build).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "server");
const { Store } = await import(path.join(dist, "store.js"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "po-archive-"));
const store = new Store(dir);

assert.deepEqual(store.readArchive("x", Date.now(), 200), { messages: [], more: false });
assert.equal(store.archiveCount("x"), 0);
assert.equal(store.hasArchive("x"), false);

// 1500 lines, three per ts (so pages cut inside a ts group), some long enough to cross the 64 KB read chunks
const all = Array.from({ length: 1500 }, (_, i) => ({ role: "assistant", text: `m${i} ` + "x".repeat(i % 97 === 0 ? 70000 : 20), ts: 1000 + Math.floor(i / 3) }));
store.archiveHistory("x", all.slice(0, 700));
assert.equal(store.archiveCount("x"), 700);
store.archiveHistory("x", all.slice(700));
fs.appendFileSync(path.join(dir, "history", "x.archive.jsonl"), '{"role":"assistant","te'); // torn by a crash: skipped
fs.appendFileSync(path.join(dir, "history", "x.archive.jsonl"), "\n");
assert.equal(store.archiveCount("x"), 1501); // lines, torn one included
assert.equal(store.hasArchive("x"), true);

// paging from the newest back reads every line exactly once, oldest first within a page
const seen = [];
let before = Date.now(), pages = 0, more = true;
while (more) {
  const r = store.readArchive("x", before, 200);
  assert.ok(r.messages.length >= 200 || !r.more, "a full page unless it is the last");
  for (let i = 1; i < r.messages.length; i++) assert.ok(r.messages[i - 1].ts <= r.messages[i].ts);
  assert.ok(r.messages.every((m) => m.ts < before));
  seen.unshift(...r.messages);
  before = r.messages[0]?.ts ?? before;
  more = r.more;
  pages++;
}
assert.equal(pages, 8);
assert.deepEqual(seen.map((m) => m.text), all.map((m) => m.text));

// a page never splits a ts group: 200 asked, the group of the 200th comes whole
const p = store.readArchive("x", 1000 + 100, 200); // lines 0..299 are older; 200th from the end is line 100, ts 1033 = lines 99..101
assert.equal(p.messages.length, 201);
assert.equal(p.messages[0].text.split(" ")[0], "m99");
assert.equal(p.more, true);

store.deleteHistory("x");
assert.equal(store.archiveCount("x"), 0);
fs.rmSync(dir, { recursive: true, force: true });
console.log("archive tests ok");
