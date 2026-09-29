import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { isObject, readJsonSafe, writeJsonAtomicSync } from "./fsutil.js";
import type { Task } from "./board.js";

// Game-style progress tied to real work: a task that reaches "done" earns its owner XP. Levels are per employee, the office
// total unlocks decor (drawn by web/office.js), and the tasks done today earn a daily badge. Finished work also earns COINS for
// the furniture market: for the task, for a level gained and for each daily badge tier (once a day). The office keeps only the running
// total; the browser's wallet credits the difference it has not seen yet, so nothing is ever counted twice. One JSON file per office.
export const XP_TASK = 10;       // a finished task
export const XP_DISCOVERY = 6;   // a finished research-only task
export const UNLOCKS = [30, 80, 160, 300, 600]; // office XP at which decor 1..5 appears (poster, hanging plant, gold coffee machine, trophy shelf, neon sign)
export const BADGES = [3, 5, 10]; // tasks done in one day: bronze, silver, gold
export const COINS_TASK = 20;          // a finished task
export const COINS_DISCOVERY = 12;     // a finished research-only task
export const COINS_LEVEL = (level: number) => 25 + 15 * level; // reaching a level (2, 3 ...)
export const COINS_BADGE = [30, 60, 120]; // reaching the bronze / silver / gold tier of a day (each once a day)
const KEEP_LOG = 30;
const KEEP_DAYS = 30, KEEP_IDS = 2000;

export const levelOf = (xp: number) => 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 20));
const levelStart = (lvl: number) => 20 * (lvl - 1) * (lvl - 1);
const dayKey = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

export interface CoinEntry { ts: number; amount: number; kind: "task" | "discovery" | "level" | "badge"; emp?: string; text?: string }
interface Data { xp: Record<string, number>; tasks: Record<string, number>; days: Record<string, number>; awarded: number[]; coins: number; badgePaid: Record<string, number>; log: CoinEntry[] }

// What the past work of an office would have earned (for a progress file from before coins existed): every finished task, every level
// reached and every badge tier of the days on record.
function pastCoins(d: Pick<Data, "xp" | "tasks" | "days">): number {
  let n = 0;
  for (const [id, xp] of Object.entries(d.xp)) { n += (d.tasks[id] ?? 0) * COINS_TASK; for (let l = 2; l <= levelOf(xp); l++) n += COINS_LEVEL(l); }
  for (const count of Object.values(d.days)) BADGES.forEach((need, i) => { if (count >= need) n += COINS_BADGE[i]; });
  return n;
}

export class Progress extends EventEmitter {
  private file: string;
  private data: Data;

  constructor(dataDir: string, existing: Task[] = []) {
    super();
    this.file = path.join(dataDir, "progress.json");
    const fresh = !isFile(this.file);
    const l = readJsonSafe<Partial<Data>>(this.file, () => ({}), { validate: isObject, label: "progress" });
    const obj = (v: unknown): Record<string, number> => (isObject(v) ? (v as Record<string, number>) : {});
    const log = Array.isArray(l.log) ? (l.log as CoinEntry[]).filter((e) => isObject(e) && typeof e.amount === "number" && typeof e.ts === "number").slice(-KEEP_LOG) : [];
    // coins: -1 marks a file from before coins existed (rebuilt below)
    this.data = { xp: obj(l.xp), tasks: obj(l.tasks), days: obj(l.days), awarded: Array.isArray(l.awarded) ? l.awarded.filter((x) => typeof x === "number") : [], coins: typeof l.coins === "number" && l.coins >= 0 ? Math.floor(l.coins) : fresh ? 0 : -1, badgePaid: obj(l.badgePaid), log };
    // the first time: work finished before this existed counts too
    if (fresh) { for (const k of existing) if (k.status === "done") this.award(k, k.updated, true); this.save(); }
    else if (this.data.coins < 0) { this.data.coins = pastCoins(this.data); this.data.badgePaid = Object.fromEntries(Object.entries(this.data.days).map(([day, n]) => [day, BADGES.filter((b) => n >= b).length])); this.save(); } // (a file from before coins)
    if (this.data.coins < 0) this.data.coins = 0;
  }

  private save() {
    try { writeJsonAtomicSync(this.file, this.data); } catch { /* progress is a bonus: never in the way of the work */ }
  }

  // A task reached "done". Once per task, however often it is reopened.
  award(k: Task, ts = Date.now(), quiet = false) {
    try {
      if (this.data.awarded.includes(k.id) || !k.owner) return;
      const gain = k.kind === "discovery" ? XP_DISCOVERY : XP_TASK;
      const levelBefore = levelOf(this.data.xp[k.owner] ?? 0);
      this.data.awarded.push(k.id);
      if (this.data.awarded.length > KEEP_IDS) this.data.awarded.splice(0, this.data.awarded.length - KEEP_IDS);
      this.data.xp[k.owner] = (this.data.xp[k.owner] ?? 0) + gain;
      this.data.tasks[k.owner] = (this.data.tasks[k.owner] ?? 0) + 1;
      const day = dayKey(ts);
      this.data.days[day] = (this.data.days[day] ?? 0) + 1;
      const keep = Object.keys(this.data.days).sort().slice(-KEEP_DAYS);
      for (const d of Object.keys(this.data.days)) if (!keep.includes(d)) delete this.data.days[d];
      for (const d of Object.keys(this.data.badgePaid)) if (!keep.includes(d)) delete this.data.badgePaid[d];
      // coins: the task, every level gained, every badge tier reached today
      const earn = (amount: number, kind: CoinEntry["kind"], text?: string) => {
        this.data.coins += amount;
        if (!quiet) { this.data.log.push({ ts, amount, kind, emp: k.owner, ...(text ? { text } : {}) }); if (this.data.log.length > KEEP_LOG) this.data.log.splice(0, this.data.log.length - KEEP_LOG); }
      };
      earn(k.kind === "discovery" ? COINS_DISCOVERY : COINS_TASK, k.kind === "discovery" ? "discovery" : "task", String(k.title ?? "").slice(0, 60));
      for (let l = levelBefore + 1; l <= levelOf(this.data.xp[k.owner] ?? 0); l++) earn(COINS_LEVEL(l), "level", String(l));
      const tier = BADGES.filter((n) => (this.data.days[day] ?? 0) >= n).length;
      for (let i = this.data.badgePaid[day] ?? 0; i < tier; i++) earn(COINS_BADGE[i], "badge", String(i + 1));
      this.data.badgePaid[day] = Math.max(this.data.badgePaid[day] ?? 0, tier);
      if (!quiet) { this.save(); this.emit("change", { emp: k.owner, gain, coins: this.data.coins }); }
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
    return { total, unlocked: UNLOCKS.filter((n) => total >= n).length, unlocks: UNLOCKS, badges: BADGES, today, badge, emps, coins: this.data.coins, coinLog: this.data.log.slice(-12).reverse(), coinRates: { task: COINS_TASK, discovery: COINS_DISCOVERY, badge: COINS_BADGE } };
  }
}
