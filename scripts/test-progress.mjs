// XP, levels, unlocks and the daily badge (src/server/progress.ts). Runs against dist/ (npm run build), in a scratch folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Progress, levelOf, UNLOCKS, COINS_TASK, COINS_DISCOVERY, COINS_LEVEL, COINS_BADGE } = await import(path.join(root, "dist/server/progress.js"));
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

// coins: for the task, a level gained, each daily badge tier (once a day); the backfill counts past work too
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "po-coins-"));
  const q = new Progress(d2, [task(1, "a"), task(2, "a", { kind: "discovery" })]);
  assert.equal(q.state().coins, COINS_TASK + COINS_DISCOVERY, "past work pays once");
  assert.deepEqual(q.state().coinLog, [], "and is not announced as news");
  q.award(task(3, "a", { title: "Ship it" }));
  assert.equal(q.state().coins, 2 * COINS_TASK + COINS_DISCOVERY + COINS_LEVEL(2) + COINS_BADGE[0], "the third task of the day reaches level 2 and the bronze badge too");
  assert.deepEqual(q.state().coinLog.map((e) => e.kind), ["badge", "level", "task"], "newest first");
  assert.equal(q.state().coinLog[2].text, "Ship it");
  const before = q.state().coins;
  q.award(task(3, "a"));
  assert.equal(q.state().coins, before, "a task pays once, however often it is reopened");
  // the level: a's xp is 26 -> level 2 (20 xp); one more task (36) stays level 2; a jump to 80 xp reaches level 3
  for (let i = 10; i < 16; i++) q.award(task(i, "a"));
  assert.ok(q.state().emps.a.level >= 3);
  const c = q.state().coins;
  const expected = 8 * COINS_TASK + COINS_DISCOVERY + COINS_LEVEL(2) + COINS_LEVEL(3) + COINS_BADGE[0] + COINS_BADGE[1] + (q.state().today >= 10 ? COINS_BADGE[2] : 0);
  assert.equal(c, expected, "tasks + levels + badge tiers, each counted once");
  assert.equal(new Progress(d2, []).state().coins, c, "and kept across a restart");
  // a file from before coins existed: what the past work would have earned, once
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "po-coins-old-"));
  const day = new Date(); const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  fs.writeFileSync(path.join(old, "progress.json"), JSON.stringify({ xp: { a: 80 }, tasks: { a: 8 }, days: { [key]: 5 }, awarded: [1, 2, 3, 4, 5, 6, 7, 8] }));
  const o = new Progress(old, []);
  assert.equal(o.state().coins, 8 * COINS_TASK + COINS_LEVEL(2) + COINS_LEVEL(3) + COINS_BADGE[0] + COINS_BADGE[1], "past tasks, levels and badge tiers");
  o.award(task(50, "a"));
  assert.equal(o.state().coins, 9 * COINS_TASK + COINS_LEVEL(2) + COINS_LEVEL(3) + COINS_BADGE[0] + COINS_BADGE[1], "today's tiers already paid are not paid again");
  assert.equal(new Progress(old, []).state().coins, o.state().coins);
  // junk in the file
  fs.writeFileSync(path.join(old, "progress.json"), JSON.stringify({ xp: { a: 30 }, tasks: { a: 3 }, days: {}, awarded: [], coins: -5, log: [null, { amount: "x" }, { ts: 1, amount: 5, kind: "task" }], badgePaid: [] }));
  const j = new Progress(old, []).state();
  assert.ok(j.coins >= 0 && Number.isInteger(j.coins) && j.coinLog.length === 1, "a negative or broken counter is rebuilt, broken log lines dropped");
}

// a broken file is not fatal
fs.writeFileSync(path.join(dir, "progress.json"), "{not json");
assert.ok(new Progress(dir).state().total >= 0); // restored from the .bak, or started empty
console.log("progress ok");
