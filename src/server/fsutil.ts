import fs from "node:fs";
import path from "node:path";

// Crash-safe file writes and corruption-tolerant JSON reads.
//
// A write goes to a temp file in the same folder, is fsynced, and is renamed over the target, so the target is always
// either the old or the new version, never half of one. With `backup`, the version being replaced is kept as `<file>.bak`
// first. A read that finds a broken file tries the `.bak`, then moves the broken file aside as `<file>.corrupt-<ts>` and
// only then falls back to an empty value, so a later save never overwrites data that could still be rescued by hand.

export interface WriteOptions {
  backup?: boolean; // keep the version being replaced as <file>.bak (default true)
  // fsync the file and the folder (default true). Off for files rewritten many times a minute (chat histories): the
  // write stays atomic, so a crash of the office never leaves half a file; only a power loss can cost the latest lines.
  durable?: boolean;
}

let counter = 0;
const tmpName = (file: string) => `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

function fsyncDir(dir: string) {
  // Makes the rename itself durable. Not possible on every platform (Windows cannot open a folder), so best effort.
  let fd: number | undefined;
  try { fd = fs.openSync(dir, "r"); fs.fsyncSync(fd); } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

export function writeFileAtomicSync(file: string, data: string | Buffer, opts: WriteOptions = {}): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = tmpName(file);
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, data);
      if (opts.durable !== false) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (opts.backup !== false) {
      // The current file was written by us (and fsynced, unless not durable), so it is the previous good version. If we crash right after
      // this rename, the target is missing and readers fall back to the .bak: only the newest write is lost.
      try { fs.renameSync(file, file + ".bak"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  if (opts.durable !== false) fsyncDir(dir);
}

export function writeJsonAtomicSync(file: string, value: unknown, opts: WriteOptions & { space?: number } = {}): void {
  writeFileAtomicSync(file, JSON.stringify(value, null, opts.space) + (opts.space ? "\n" : ""), opts);
}

export async function writeFileAtomic(file: string, data: string | Buffer, opts: WriteOptions = {}): Promise<void> {
  const fsp = fs.promises;
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = tmpName(file);
  try {
    const fh = await fsp.open(tmp, "w");
    try {
      await fh.writeFile(data);
      if (opts.durable !== false) await fh.sync();
    } finally {
      await fh.close();
    }
    if (opts.backup !== false) {
      try { await fsp.rename(file, file + ".bak"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    await fsp.rename(tmp, file);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch {}
    throw e;
  }
  if (opts.durable !== false) fsyncDir(dir);
}

export function writeJsonAtomic(file: string, value: unknown, opts: WriteOptions & { space?: number } = {}): Promise<void> {
  return writeFileAtomic(file, JSON.stringify(value, null, opts.space) + (opts.space ? "\n" : ""), opts);
}

// Temp files left behind by a crash mid-write. They are never read; this only tidies them up once they are clearly stale.
function sweepTemps(file: string) {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + ".tmp-";
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const p = path.join(dir, n);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 60_000) fs.unlinkSync(p); } catch {}
  }
}

function moveAside(file: string): string | undefined {
  const base = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let dest = base;
  for (let i = 1; fs.existsSync(dest); i++) dest = `${base}-${i}`; // never overwrite an earlier corrupt copy
  try { fs.renameSync(file, dest); return dest; } catch { return undefined; }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; missing: boolean; error?: unknown };

function tryRead<T>(file: string, validate?: (v: unknown) => boolean): Parsed<T> {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, missing: true };
    return { ok: false, missing: false, error: e };
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (validate && !validate(value)) return { ok: false, missing: false, error: new Error("unexpected shape") };
    return { ok: true, value: value as T };
  } catch (e) {
    return { ok: false, missing: false, error: e };
  }
}

export interface ReadOptions {
  validate?: (v: unknown) => boolean; // a value that parses but fails this counts as corrupt
  label?: string;                     // what the file is, for the log ("board", "history of ali")
}

export const isObject = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);

// Reads a JSON file written by writeJsonAtomicSync. Never throws for a missing or broken file:
//   good file            -> its value
//   missing file         -> the .bak if it is good (a crash between the two renames), else the fallback
//   broken file, good .bak -> the .bak's value; the broken file is moved aside
//   broken file and .bak -> the broken file is moved aside, the fallback is returned; logged loudly
export function readJsonSafe<T>(file: string, fallback: () => T, opts: ReadOptions = {}): T {
  sweepTemps(file);
  const label = opts.label ?? path.basename(file);
  const main = tryRead<T>(file, opts.validate);
  if (main.ok) return main.value;
  const bak = tryRead<T>(file + ".bak", opts.validate);
  if (main.missing) {
    if (bak.ok) {
      console.warn(`[pixel-office] ${label}: ${file} is missing, restored from ${file}.bak`);
      return bak.value;
    }
    return fallback();
  }
  const reason = main.error instanceof Error ? main.error.message : String(main.error);
  const aside = moveAside(file);
  const where = aside ? `moved to ${aside}` : "could not be moved aside";
  if (bak.ok) {
    console.error(`[pixel-office] ${label}: ${file} is corrupt (${reason}); ${where}. Restored the previous version from ${file}.bak.`);
    return bak.value;
  }
  console.error(
    `\n[pixel-office] !!! ${label}: ${file} is corrupt (${reason}) and there is no usable backup.\n` +
    `[pixel-office] !!! The broken file was ${where}; starting ${label} empty. Recover it from there by hand if needed.\n`,
  );
  return fallback();
}

// Removes a file written by writeFileAtomicSync together with its .bak (otherwise a missing file would be revived from it).
export function removeWithBackup(file: string): void {
  for (const p of [file, file + ".bak"]) try { fs.unlinkSync(p); } catch {}
}
