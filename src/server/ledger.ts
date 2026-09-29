import path from "node:path";
import { appendJsonLineSync, readJsonLines } from "./fsutil.js";
import type { Engine } from "./providers.js";

// What the office spent, one line per finished turn. Unlike an employee's running total it never shrinks: a reset or a
// fired employee leaves their lines here, so "what did today cost" stays true.
export type CostKind = "chat" | "task" | "refresh" | "meeting" | "discovery";
export const COST_KINDS: readonly CostKind[] = ["chat", "task", "refresh", "meeting", "discovery"];
export interface CostLine {
  ts: number;
  emp: string;
  empName: string;
  engine: Engine;
  model: string;
  kind: CostKind;
  task?: number;
  cost: number; // USD; 0 for Codex (it runs on the ChatGPT plan)
  tokens?: { input: number; output: number; cached?: number };
}
export interface Cap { daily: number; codexTokens: number } // 0 = off

const KEEP_DAYS = 120; // older lines stay in the file; memory only holds what the reports can ask for
// Local day: "today" ends at the boss's midnight, not at UTC's.
export const dayKey = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const startOfDay = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const codexTokensOf = (l: CostLine) => (l.engine === "codex" && l.tokens ? l.tokens.input + l.tokens.output : 0);
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export class Ledger {
  private file: string;
  private lines: CostLine[];

  constructor(dir: string) {
    this.file = path.join(dir, "costs.jsonl");
    const from = Date.now() - KEEP_DAYS * 86400e3;
    this.lines = readJsonLines<CostLine>(this.file, (l) => typeof l.ts === "number" && l.ts >= from && typeof l.cost === "number");
  }

  add(line: CostLine) {
    appendJsonLineSync(this.file, line);
    this.lines.push(line);
  }

  // Spent since local midnight: dollars (Claude) and tokens (Codex).
  today(now = Date.now()) {
    const from = startOfDay(now);
    let cost = 0, codex = 0;
    for (let i = this.lines.length - 1; i >= 0 && this.lines[i].ts >= from; i--) { cost += this.lines[i].cost; codex += codexTokensOf(this.lines[i]); }
    return { cost: round(cost), codexTokens: codex };
  }

  // Cost and Codex tokens of one task since `since` (a run), or over its whole life.
  forTask(id: number, since = 0, until = Infinity) {
    let cost = 0, codex = 0;
    for (const l of this.lines) if (l.task === id && l.ts >= since && l.ts <= until) { cost += l.cost; codex += codexTokensOf(l); }
    return { cost: round(cost), codexTokens: codex };
  }

  summary(days: number, titleOf: (task: number) => string | undefined, now = Date.now()) {
    const today = startOfDay(now);
    const from = today - (days - 1) * 86400e3;
    const perDay = new Map<string, { day: string; cost: number; codexTokens: number }>();
    for (let i = 0; i < days; i++) { const day = dayKey(from + i * 86400e3 + 12 * 3600e3); perDay.set(day, { day, cost: 0, codexTokens: 0 }); } // noon: safe across DST
    const emps = new Map<string, { emp: string; name: string; today: number; period: number; codexTokens: number }>();
    const tasks = new Map<number, { task: number; title: string; cost: number; codexTokens: number }>();
    const byKind: Record<CostKind, number> = { chat: 0, task: 0, refresh: 0, meeting: 0, discovery: 0 };
    for (const l of this.lines) {
      if (l.ts < from) continue;
      const tok = codexTokensOf(l);
      const d = perDay.get(dayKey(l.ts));
      if (d) { d.cost += l.cost; d.codexTokens += tok; }
      const e = emps.get(l.emp) ?? { emp: l.emp, name: l.empName, today: 0, period: 0, codexTokens: 0 };
      e.name = l.empName || e.name;
      e.period += l.cost; e.codexTokens += tok;
      if (l.ts >= today) e.today += l.cost;
      emps.set(l.emp, e);
      if (l.task !== undefined) {
        const k = tasks.get(l.task) ?? { task: l.task, title: titleOf(l.task) ?? `#${l.task}`, cost: 0, codexTokens: 0 };
        k.cost += l.cost; k.codexTokens += tok;
        tasks.set(l.task, k);
      }
      if (l.kind in byKind) byKind[l.kind] += l.cost;
    }
    const t = this.today(now);
    return {
      today: t.cost, todayTokens: { codex: t.codexTokens },
      days: [...perDay.values()].map((d) => ({ ...d, cost: round(d.cost) })),
      byEmployee: [...emps.values()].map((e) => ({ ...e, today: round(e.today), period: round(e.period) })).sort((a, b) => b.period - a.period || b.codexTokens - a.codexTokens),
      byTask: [...tasks.values()].map((k) => ({ ...k, cost: round(k.cost) })).sort((a, b) => b.cost - a.cost || b.codexTokens - a.codexTokens).slice(0, 15),
      byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, round(v)])) as Record<CostKind, number>,
    };
  }
}
