import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// How much of the plans' rate limits is used, from what the engines report anyway: Claude sends `rate_limit_event` messages
// (and answers the /usage control request, a plain HTTP call that costs no tokens); Codex writes `rate_limits` into the
// thread's rollout file. Nothing here ever asks a model. The last value seen is kept, for every office alike.
export interface Window { pct: number; resetsAt: number; windowMin?: number }
export interface Quota {
  claude: { fiveHour: Window | null; week: Window | null; updated: number } | null;
  codex: { primary: Window | null; secondary: Window | null; updated: number } | null;
}

const quota: Quota = { claude: null, codex: null };
let listener: (q: Quota) => void = () => {};
export const getQuota = (): Quota => quota;
export const onQuota = (fn: (q: Quota) => void) => { listener = fn; };

const pctOf = (v: unknown, fraction: boolean) => { const n = Number(v); return Number.isFinite(n) ? Math.round((fraction ? n * 100 : n) * 10) / 10 : undefined; };
// seconds or ms since epoch, or an ISO date → ms
const msOf = (v: unknown): number => {
  if (typeof v === "string") { const n = Date.parse(v); return Number.isFinite(n) ? n : 0; }
  const n = Number(v);
  return !Number.isFinite(n) || n <= 0 ? 0 : n < 1e12 ? n * 1000 : n;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function setClaude(patch: { fiveHour?: Window; week?: Window }) {
  const prev = quota.claude ?? { fiveHour: null, week: null, updated: 0 };
  const next = { fiveHour: patch.fiveHour ?? prev.fiveHour, week: patch.week ?? prev.week, updated: Date.now() };
  const changed = !same({ ...prev, updated: 0 }, { ...next, updated: 0 });
  quota.claude = next;
  if (changed) listener(quota);
}

// SDK `rate_limit_event.rate_limit_info`: utilization is a fraction (0.42), resetsAt in seconds. Newer CLIs also carry
// every window at once in `unifiedWindows`.
export function fromClaudeRateLimit(info: Record<string, unknown> | undefined) {
  if (!info) return;
  const patch: { fiveHour?: Window; week?: Window } = {};
  const win = (u: unknown, r: unknown): Window | undefined => { const pct = pctOf(u, Number(u) <= 1); return pct === undefined ? undefined : { pct, resetsAt: msOf(r) }; };
  const uw = info.unifiedWindows as Record<string, { utilization?: unknown; resetsAt?: unknown }> | undefined;
  if (uw?.five_hour) patch.fiveHour = win(uw.five_hour.utilization, uw.five_hour.resetsAt);
  if (uw?.seven_day) patch.week = win(uw.seven_day.utilization, uw.seven_day.resetsAt);
  if (info.utilization !== undefined) {
    const w = win(info.utilization, info.resetsAt);
    if (info.rateLimitType === "five_hour" && w) patch.fiveHour = w;
    else if (info.rateLimitType === "seven_day" && w) patch.week = w;
  }
  // "rejected" without numbers: the window is full
  if (info.status === "rejected" && info.utilization === undefined) {
    if (info.rateLimitType === "five_hour") patch.fiveHour = { pct: 100, resetsAt: msOf(info.resetsAt) };
    else if (info.rateLimitType === "seven_day") patch.week = { pct: 100, resetsAt: msOf(info.resetsAt) };
  }
  if (patch.fiveHour || patch.week) setClaude(patch);
}

// The answer to the SDK's /usage control request (experimental): utilization in percent, resets_at ISO.
export function fromClaudeUsage(resp: unknown) {
  const rl = (resp as { rate_limits?: Record<string, unknown> | null } | undefined)?.rate_limits;
  if (!rl) return;
  const patch: { fiveHour?: Window; week?: Window } = {};
  const win = (x: unknown): Window | undefined => {
    const o = x as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    const pct = o ? pctOf(o.utilization, false) : undefined;
    return pct === undefined ? undefined : { pct, resetsAt: msOf(o!.resets_at) };
  };
  patch.fiveHour = win(rl.five_hour);
  patch.week = win(rl.seven_day);
  // the newer shape: rows by kind
  for (const row of Array.isArray(rl.limits) ? (rl.limits as Array<Record<string, unknown>>) : []) {
    const w = { pct: pctOf(row.percent, false) ?? 0, resetsAt: msOf(row.resets_at) };
    if (row.kind === "session" && !patch.fiveHour) patch.fiveHour = w;
    else if (row.kind === "weekly_all" && !patch.week) patch.week = w;
  }
  if (patch.fiveHour || patch.week) setClaude(patch);
}

// ---- Codex: the rollout file of a thread ends with its latest token_count event, which carries the plan's windows ----
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const rolloutCache = new Map<string, string>();
function findRollout(thread: string): string | undefined {
  const hit = rolloutCache.get(thread);
  if (hit && fs.existsSync(hit)) return hit;
  const root = path.join(codexHome(), "sessions");
  const ls = (d: string) => { try { return fs.readdirSync(d).sort().reverse(); } catch { return []; } };
  let days = 0;
  // sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl, newest day first; a thread lives in the folder of the day it began
  for (const y of ls(root)) for (const m of ls(path.join(root, y))) for (const d of ls(path.join(root, y, m))) {
    if (++days > 90) return undefined;
    const dir = path.join(root, y, m, d);
    const f = ls(dir).find((n) => n.endsWith(`${thread}.jsonl`));
    if (f) { const p = path.join(dir, f); rolloutCache.set(thread, p); return p; }
  }
  return undefined;
}

export async function fromCodexThread(thread: string | undefined) {
  if (!thread) return;
  const file = findRollout(thread);
  if (!file) return;
  let tail = "";
  try {
    const fh = await fs.promises.open(file, "r");
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      tail = buf.toString("utf8");
    } finally { await fh.close(); }
  } catch { return; }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let ev: { payload?: { rate_limits?: Record<string, { used_percent?: number; window_minutes?: number; resets_at?: number } | null> } };
    try { ev = JSON.parse(lines[i]); } catch { continue; }
    const rl = ev.payload?.rate_limits;
    if (!rl) continue;
    const win = (x: { used_percent?: number; window_minutes?: number; resets_at?: number } | null | undefined): Window | null =>
      x && typeof x.used_percent === "number" ? { pct: Math.round(x.used_percent * 10) / 10, resetsAt: msOf(x.resets_at), ...(x.window_minutes ? { windowMin: x.window_minutes } : {}) } : null;
    const next = { primary: win(rl.primary), secondary: win(rl.secondary), updated: Date.now() };
    if (!next.primary && !next.secondary) return;
    const changed = !same({ ...quota.codex, updated: 0 }, { ...next, updated: 0 });
    quota.codex = next;
    if (changed) listener(quota);
    return;
  }
}

// The /usage request is asked at most every few minutes, whoever finishes a turn.
let usageAsked = 0;
export function claudeUsageDue(now = Date.now()): boolean {
  if (now - usageAsked < 5 * 60e3) return false;
  usageAsked = now;
  return true;
}
