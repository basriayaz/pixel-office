// XP, levels, unlocks and the daily badge (src/server/progress.ts). Runs against dist/ (npm run build), in a scratch folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Progress, levelOf, UNLOCKS } = await import(path.join(root, "dist/server/progress.js"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "po-progress-"));
const task = (id, owner, extra = {}) => ({ id, owner, title: "t", status: "done", updated: Date.now(), notes: [], ...extra });

// backfill on the first start: work already done counts once
let p = new Progress(dir, [task(1, "a"), task(2, "a", { kind: "discovery" }), task(3, "b", { status: "todo" })]);
let s = p.state();
assert.equal(s.total, 16);
assert.equal(s.emps.a.tasks, 2);
assert.equal(s.emps.b, undefined);

// the same task earns once, however often it is reopened
let changes = 0;
p.on("change", () => changes++);
p.award(task(1, "a"));
assert.equal(changes, 0);
p.award(task(4, "b"));
assert.equal(changes, 1);
assert.equal(p.state().emps.b.xp, 10);

// persisted: a new instance (existing tasks ignored, the file exists) sees the same numbers
p = new Progress(dir, [task(9, "z")]);
assert.equal(p.state().total, 26);
assert.equal(p.state().emps.z, undefined);

// levels, unlocks, daily badge
assert.deepEqual([0, 19, 20, 79, 80, 180].map(levelOf), [1, 1, 2, 2, 3, 4]);
for (let i = 10; i < 20; i++) p.award(task(i, "a"));
s = p.state();
assert.equal(s.total, 126);
assert.equal(s.unlocked, UNLOCKS.filter((n) => 126 >= n).length);
assert.equal(s.today, 13);
assert.equal(s.badge, 3);

// a broken file is not fatal
fs.writeFileSync(path.join(dir, "progress.json"), "{not json");
assert.ok(new Progress(dir).state().total >= 0); // restored from the .bak, or started empty
console.log("progress ok");
