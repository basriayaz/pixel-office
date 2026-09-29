import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { isObject, readJsonSafe, writeJsonAtomicSync } from "./fsutil.js";
import type { Task } from "./board.js";

// Game-style progress tied to real work: a task that reaches "done" earns its owner XP. Levels are per employee, the office
// total unlocks decor (drawn by web/office.js), and the tasks done today earn a daily badge. One JSON file per office.
export const XP_TASK = 10;       // a finished task
export const XP_DISCOVERY = 6;   // a finished research-only task
export const UNLOCKS = [30, 80, 160, 300, 600]; // office XP at which decor 1..5 appears (poster, hanging plant, gold coffee machine, trophy shelf, neon sign)
export const BADGES = [3, 5, 10]; // tasks done in one day: bronze, silver, gold
const KEEP_DAYS = 30, KEEP_IDS = 2000;

export const levelOf = (xp: number) => 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 20));
const levelStart = (lvl: number) => 20 * (lvl - 1) * (lvl - 1);
const dayKey = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

interface Data { xp: Record<string, number>; tasks: Record<string, number>; days: Record<string, number>; awarded: number[] }

export class Progress extends EventEmitter {
  private file: string;
  private data: Data;

  constructor(dataDir: string, existing: Task[] = []) {
    super();
    this.file = path.join(dataDir, "progress.json");
    const fresh = !isFile(this.file);
    const l = readJsonSafe<Partial<Data>>(this.file, () => ({}), { validate: isObject, label: "progress" });
    const obj = (v: unknown): Record<string, number> => (isObject(v) ? (v as Record<string, number>) : {});
    this.data = { xp: obj(l.xp), tasks: obj(l.tasks), days: obj(l.days), awarded: Array.isArray(l.awarded) ? l.awarded.filter((x) => typeof x === "number") : [] };
    // the first time: work finished before this existed counts too
    if (fresh) { for (const k of existing) if (k.status === "done") this.award(k, k.updated, true); this.save(); }
  }

  private save() {
    try { writeJsonAtomicSync(this.file, this.data); } catch { /* progress is a bonus: never in the way of the work */ }
  }

  // A task reached "done". Once per task, however often it is reopened.
  award(k: Task, ts = Date.now(), quiet = false) {
    try {
      if (this.data.awarded.includes(k.id) || !k.owner) return;
      const gain = k.kind === "discovery" ? XP_DISCOVERY : XP_TASK;
      this.data.awarded.push(k.id);
      if (this.data.awarded.length > KEEP_IDS) this.data.awarded.splice(0, this.data.awarded.length - KEEP_IDS);
      this.data.xp[k.owner] = (this.data.xp[k.owner] ?? 0) + gain;
      this.data.tasks[k.owner] = (this.data.tasks[k.owner] ?? 0) + 1;
      const day = dayKey(ts);
      this.data.days[day] = (this.data.days[day] ?? 0) + 1;
      const keep = Object.keys(this.data.days).sort().slice(-KEEP_DAYS);
      for (const d of Object.keys(this.data.days)) if (!keep.includes(d)) delete this.data.days[d];
      if (!quiet) { this.save(); this.emit("change", { emp: k.owner, gain }); }
    } catch { /* silent */ }
  }

  get total() { return Object.values(this.data.xp).reduce((a, b) => a + b, 0); }

  state() {
    const total = this.total, today = this.data.days[dayKey(Date.now())] ?? 0;
    const emps: Record<string, { xp: number; tasks: number; level: number; from: number; next: number }> = {};
    for (const [id, xp] of Object.entries(this.data.xp)) {
      const level = levelOf(xp);
      emps[id] = { xp, tasks: this.data.tasks[id] ?? 0, level, from: levelStart(level), next: levelStart(level + 1) };
    }
    const badge = BADGES.filter((n) => today >= n).length; // 0 none, 1..3 tiers
    return { total, unlocked: UNLOCKS.filter((n) => total >= n).length, unlocks: UNLOCKS, badges: BADGES, today, badge, emps };
  }
}
