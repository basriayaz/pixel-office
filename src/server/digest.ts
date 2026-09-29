import { execFileSync } from "node:child_process";
import type { Task } from "./board.js";
import { t } from "./runtime.js";

// A short "current state" block put in front of the boss's messages, meeting prompts and task starts, so a long session
// does not answer from what was true when it began. Only facts: the board, git in the employee's folder, the server's start.
// Anything that cannot be read becomes "unavailable" on its own line; building the block never throws.

export const SERVER_STARTED = Date.now();

type Tr = (key: string, vars?: Record<string, string | number>) => string;

const pad = (n: number) => String(n).padStart(2, "0");
export function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export interface GitFacts { changed?: number; untracked?: number; commit?: { hash: string; ts: number; subject: string }; behind?: number; ahead?: number }

// Local only: no fetch, origin/main is what this clone last heard of it.
export function gitFacts(cwd: string): GitFacts {
  const out: GitFacts = {};
  try {
    const lines = git(cwd, ["status", "--porcelain"]).split("\n").filter(Boolean);
    out.untracked = lines.filter((l) => l.startsWith("??")).length;
    out.changed = lines.length - out.untracked;
  } catch {}
  try {
    const [hash, ct, ...subject] = git(cwd, ["log", "-1", "--format=%h%x09%ct%x09%s"]).split("\t");
    if (hash && ct) out.commit = { hash, ts: Number(ct) * 1000, subject: subject.join("\t") };
  } catch {}
  try {
    const [behind, ahead] = git(cwd, ["rev-list", "--left-right", "--count", "origin/main...HEAD"]).split(/\s+/).map(Number);
    if (Number.isFinite(behind) && Number.isFinite(ahead)) { out.behind = behind; out.ahead = ahead; }
  } catch {}
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function buildDigest(o: { now: number; tasks?: Task[]; git: GitFacts; started: number }, tr: Tr = t): string {
  const na = tr("server.digest.na");
  const lines = [tr("server.digest.head", { time: stamp(o.now) })];
  if (!o.tasks) lines.push(tr("server.digest.board", { counts: na }));
  else {
    const by = (s: Task["status"]) => o.tasks!.filter((x) => x.status === s);
    lines.push(tr("server.digest.board", { counts: tr("server.digest.counts", { todo: by("todo").length, doing: by("doing").length, review: by("review").length, blocked: by("blocked").length }) }));
    const active = o.tasks.filter((x) => x.status === "doing" || x.status === "review" || x.status === "blocked").slice(0, 5)
      .map((x) => `#${x.id} ${clip(x.title, 50)} (${tr("server.digest.st." + x.status)})`);
    if (active.length) lines.push(tr("server.digest.active", { list: active.join("; ") }));
    const done = by("done").sort((a, b) => b.updated - a.updated).slice(0, 3).map((x) => `#${x.id} ${clip(x.title, 50)} (${stamp(x.updated)})`);
    lines.push(tr("server.digest.done", { list: done.join("; ") || "-" }));
  }
  const g = o.git;
  lines.push(tr("server.digest.tree", g.changed === undefined ? { state: na } : { state: tr("server.digest.treeState", { changed: g.changed, untracked: g.untracked ?? 0 }) }));
  lines.push(tr("server.digest.commit", { commit: g.commit ? `${g.commit.hash} ${stamp(g.commit.ts)} "${clip(g.commit.subject, 70)}"` : na }));
  lines.push(tr("server.digest.push", { state: g.ahead === undefined ? na : tr("server.digest.pushState", { behind: g.behind ?? 0, ahead: g.ahead }) }));
  lines.push(tr("server.digest.live", {
    started: stamp(o.started),
    state: !g.commit ? na : tr(o.started >= g.commit.ts ? "server.digest.liveYes" : "server.digest.liveNo"),
  }));
  lines.push(tr("server.digest.rule"));
  return lines.join("\n");
}

// Never throws: a missing board or a folder that is not a git repository only makes those lines "unavailable".
export function statusDigest(cwd: string, tasks?: Task[]): string {
  try {
    return buildDigest({ now: Date.now(), tasks, git: gitFacts(cwd), started: SERVER_STARTED });
  } catch {
    return "";
  }
}
