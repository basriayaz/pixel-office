import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./employee.js";
import { isObject, readJsonSafe, removeWithBackup, writeJsonAtomicSync } from "./fsutil.js";

// Chat history saves are batched: a streaming employee adds many lines a second, and each save rewrites the whole file.
const HISTORY_SAVE_DELAY_MS = 250;
// Every store with a batched save still waiting, so the process writes them all before it exits (exit handlers run sync).
const pendingStores = new Set<Store>();
process.on("exit", () => { for (const s of pendingStores) s.flushHistory(); });

interface State {
  sessions: Record<string, string>;
  meta: Record<string, Record<string, unknown>>;
}

export class Store {
  private statePath: string;
  private historyDir: string;
  private attachmentsDir: string;
  private state: State;
  private pendingHistory = new Map<string, ChatMessage[]>();
  private historyTimer?: NodeJS.Timeout;

  constructor(private dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.statePath = path.join(dataDir, "state.json");
    this.historyDir = path.join(dataDir, "history");
    fs.mkdirSync(this.historyDir, { recursive: true });
    this.attachmentsDir = path.join(dataDir, "attachments");
    // A broken state.json is restored from its .bak, or moved aside, and never stops the server from starting.
    const loaded = readJsonSafe<Partial<State>>(this.statePath, () => ({}), { validate: isObject, label: "office state" });
    this.state = { sessions: isObject(loaded.sessions) ? loaded.sessions! : {}, meta: isObject(loaded.meta) ? loaded.meta! : {} };
  }

  get dir() { return this.dataDir; }

  private save() {
    writeJsonAtomicSync(this.statePath, this.state, { space: 2 });
  }

  getSession(id: string): string | undefined {
    return this.state.sessions[id];
  }

  setSession(id: string, sessionId: string | undefined) {
    if (sessionId) this.state.sessions[id] = sessionId;
    else delete this.state.sessions[id];
    this.save();
  }

  getMeta<T>(id: string, key: string): T | undefined {
    return this.state.meta[id]?.[key] as T | undefined;
  }

  setMeta(id: string, key: string, value: unknown) {
    (this.state.meta[id] ??= {})[key] = value;
    this.save();
  }

  deleteHistory(id: string) {
    this.pendingHistory.delete(id); // a batched save must not bring the file back
    removeWithBackup(path.join(this.historyDir, `${id}.json`));
    removeWithBackup(this.archivePath(id));
    this.archiveCounts.delete(id);
    fs.rmSync(path.join(this.attachmentsDir, id), { recursive: true, force: true });
  }

  // Stores an image pasted into a chat; returns the file name to reference it by.
  saveAttachment(id: string, data: Buffer, ext: string): string {
    const dir = path.join(this.attachmentsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(dir, name), data);
    return name;
  }

  // Meeting transcripts, one JSON file per meeting, newest first when listed.
  saveMeeting(id: string, data: unknown) {
    const dir = path.join(this.dataDir, "meetings");
    fs.mkdirSync(dir, { recursive: true });
    // Rewritten on every entry, so no .bak: the worst a crash can cost is the last line, and the folder listing stays clean.
    writeJsonAtomicSync(path.join(dir, `${id}.json`), data, { backup: false });
  }

  listMeetings(): Array<{ id: string; topic: string; startedAt: number; endedAt?: number }> {
    const dir = path.join(this.dataDir, "meetings");
    if (!fs.existsSync(dir)) return [];
    const out: Array<{ id: string; topic: string; startedAt: number; endedAt?: number }> = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort().reverse().slice(0, 50)) {
      try { const m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); out.push({ id: m.id, topic: m.topic, startedAt: m.startedAt, endedAt: m.endedAt }); } catch {}
    }
    return out;
  }

  loadMeeting(id: string): unknown | null {
    if (!/^[\w.-]+$/.test(id)) return null;
    const p = path.join(this.dataDir, "meetings", `${id}.json`);
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
  }

  attachmentPath(id: string, name: string): string | null {
    if (!/^[\w.-]+$/.test(name) || !/^[\w.-]+$/.test(id)) return null;
    const p = path.join(this.attachmentsDir, id, name);
    return fs.existsSync(p) ? p : null;
  }

  loadHistory(id: string): ChatMessage[] {
    const p = path.join(this.historyDir, `${id}.json`);
    // One broken history file must not stop the server: it is restored from its .bak, or moved aside and started empty.
    return readJsonSafe<ChatMessage[]>(p, () => [], { validate: Array.isArray, label: `chat history of ${id}` });
  }

  // Batched: the file is rewritten at most every HISTORY_SAVE_DELAY_MS with the latest array, and at exit (flushHistory).
  // Without fsync (still atomic, with a .bak): an fsync here blocked the office for ~10 ms per line while employees streamed.
  // Board, state and config keep their fsync. A hard kill can lose the last quarter second of chat, never the file.
  saveHistory(id: string, history: ChatMessage[]) {
    this.pendingHistory.set(id, history);
    pendingStores.add(this);
    this.historyTimer ??= setTimeout(() => this.flushHistory(), HISTORY_SAVE_DELAY_MS).unref();
  }

  // Writes every batched history save now. Each file on its own: one failing (disk full) does not stop the others.
  flushHistory() {
    clearTimeout(this.historyTimer);
    this.historyTimer = undefined;
    pendingStores.delete(this);
    const pending = [...this.pendingHistory];
    this.pendingHistory.clear();
    for (const [id, history] of pending) {
      try { writeJsonAtomicSync(path.join(this.historyDir, `${id}.json`), history, { durable: false }); }
      catch (err) { console.error(`[pixel-office] could not save the chat history of ${id}:`, (err as Error).message); }
    }
  }

  // Old chat lines trimmed from the live history, appended one per line to history/<id>.archive.jsonl (read back page by page
  // by readArchive). Written before the trimmed history is saved: a crash in between duplicates, never loses.
  archiveHistory(id: string, lines: ChatMessage[]) {
    if (!lines.length) return;
    fs.appendFileSync(this.archivePath(id), lines.map((m) => JSON.stringify(m)).join("\n") + "\n");
  }

  private archivePath(id: string) { return path.join(this.historyDir, `${id}.archive.jsonl`); }

  hasArchive(id: string): boolean {
    try { return fs.statSync(this.archivePath(id)).size > 0; } catch { return false; }
  }

  // Lines in the archive. The file only grows, so the count is cached with the size it was taken at and only the new tail is read.
  private archiveCounts = new Map<string, { size: number; lines: number }>();
  archiveCount(id: string): number {
    let size: number;
    try { size = fs.statSync(this.archivePath(id)).size; } catch { this.archiveCounts.delete(id); return 0; }
    let c = this.archiveCounts.get(id);
    if (!c || c.size > size) c = { size: 0, lines: 0 }; // replaced or removed since: count again
    if (c.size < size) {
      const fd = fs.openSync(this.archivePath(id), "r");
      try {
        const buf = Buffer.alloc(64 * 1024);
        for (let pos = c.size; pos < size; ) {
          const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
          if (n <= 0) break;
          for (let i = 0; i < n; i++) if (buf[i] === 10) c.lines++;
          pos += n;
        }
      } finally { fs.closeSync(fd); }
      c.size = size;
    }
    this.archiveCounts.set(id, c);
    return c.lines;
  }

  // One page of archived lines older than `before` (ts, ms), oldest first, read backwards from the end of the file so a big
  // archive is not loaded whole. Lines sharing the ts of the page's oldest line all come along, so paging by ts skips none.
  // `more`: older lines are left for another page.
  readArchive(id: string, before: number, limit: number): { messages: ChatMessage[]; more: boolean } {
    let fd: number;
    try { fd = fs.openSync(this.archivePath(id), "r"); } catch { return { messages: [], more: false }; }
    const out: ChatMessage[] = []; // newest first while reading
    let more = false;
    try {
      const chunk = Buffer.alloc(64 * 1024);
      let pos = fs.fstatSync(fd).size;
      let rest = Buffer.alloc(0); // the start of a line whose beginning is in the part not read yet
      const take = (line: Buffer): boolean => { // false once the page is full and this line is older than it
        if (!line.length) return true;
        let m: ChatMessage;
        try { m = JSON.parse(line.toString("utf8")); } catch { return true; } // a torn line (crash mid-append) is skipped
        if (!m || typeof m.ts !== "number" || m.ts >= before) return true;
        if (out.length >= limit && m.ts !== out[out.length - 1].ts) { more = true; return false; }
        out.push(m);
        return true;
      };
      scan: while (pos > 0) {
        const n = Math.min(chunk.length, pos);
        pos -= n;
        fs.readSync(fd, chunk, 0, n, pos);
        const buf = Buffer.concat([chunk.subarray(0, n), rest]);
        let end = buf.length;
        for (let i = buf.length - 1; i >= 0; i--) {
          if (buf[i] !== 10) continue;
          if (!take(buf.subarray(i + 1, end))) break scan;
          end = i;
        }
        rest = Buffer.from(buf.subarray(0, end));
      }
      if (pos === 0 && !more && rest.length) take(rest);
    } finally { fs.closeSync(fd); }
    return { messages: out.reverse(), more };
  }
}
