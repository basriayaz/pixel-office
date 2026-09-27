import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// One server per data folder. Two servers on the same folder (for example the same home on two ports) would each keep
// their own copy of the board and the state in memory and overwrite each other's saves.
//
// The lock is the existing `server.pid` file (first line the pid, which `pixel-office stop` already reads; then the port
// and the time the lock was taken). It is created exclusively, so two servers starting at the same moment cannot both win.
// A lock is only honoured while its pid is still the very process that wrote it (see `isLockHolder`); anything else is
// stale and taken over. The same check keeps `pixel-office stop` from ever signalling a process that merely reuses the pid.

export type LockResult =
  | { ok: true; release: () => void }
  | { ok: false; pid: number; port: number | null };

export interface LockInfo { pid: number; port: number | null; since: number | null }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// `ps` for one pid, in the C locale so the date format does not depend on the user's language. null = no such process;
// undefined = ps itself could not be asked.
function ps(pid: number, field: "lstart" | "command"): string | null | undefined {
  try {
    const out = execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
      encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", LANG: "C" },
    }).trim();
    return out || null;
  } catch (e) {
    return (e as { status?: number }).status === 1 ? null : undefined; // ps exits 1 when the pid does not exist
  }
}

// Is `info.pid` still the server that wrote this lock? After a crash or a reboot the pid can belong to any other process
// (Claude Code, an editor's tsserver: node programs too), so "it is a node process" is not enough:
//  - the lock records when it was taken, and a process started after that moment cannot have written it. A pid is only
//    reused after its first owner died, which is after the lock was written, so a reused pid always started later.
//  - a lock without that time (written by an older version) must at least be held by something running the server.
export function isLockHolder(info: LockInfo): boolean {
  if (!alive(info.pid)) return false;
  if (process.platform === "win32") return true; // no ps: stay on the safe side and treat it as held
  const cmd = ps(info.pid, "command");
  if (cmd === null) return false;
  if (cmd !== undefined && !/node|tsx|bun|deno|pixel-office/i.test(cmd)) return false;
  if (info.since !== null) {
    const lstart = ps(info.pid, "lstart");
    if (lstart === null) return false;
    const started = lstart === undefined ? NaN : new Date(lstart).getTime();
    // lstart has whole seconds; allow 2 s for that and small clock differences
    if (Number.isFinite(started)) return started <= info.since + 2000;
    return cmd !== undefined && /server[\\/]index\.[jt]s|pixel-office/i.test(cmd);
  }
  return cmd === undefined || /server[\\/]index\.[jt]s|pixel-office/i.test(cmd);
}

export function readLock(file: string): LockInfo | null {
  try {
    const [pid, port, since] = fs.readFileSync(file, "utf8").split("\n").map((s) => s.trim());
    const p = Number(pid), po = Number(port), t = since ? Date.parse(since) : NaN;
    return Number.isInteger(p) && p > 0 ? { pid: p, port: Number.isInteger(po) && po > 0 ? po : null, since: Number.isFinite(t) ? t : null } : null;
  } catch { return null; }
}

export function acquireLock(file: string, port: number): LockResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${process.pid}\n${port}\n${new Date().toISOString()}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: "wx" });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        // only our own lock: never delete one a newer server took over after we were presumed dead
        if (readLock(file)?.pid === process.pid) try { fs.rmSync(file, { force: true }); } catch {}
      };
      return { ok: true, release };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const held = readLock(file);
    if (held && held.pid !== process.pid && isLockHolder(held)) return { ok: false, pid: held.pid, port: held.port };
    // stale (process gone, pid reused by something else, or an unreadable file): clear it and try again
    if (held?.pid !== process.pid) console.warn(`Removing a stale lock ${file}${held ? ` (pid ${held.pid} is no longer the Pixel Office server that wrote it)` : ""}.`);
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  const held = readLock(file);
  return { ok: false, pid: held?.pid ?? 0, port: held?.port ?? null };
}
