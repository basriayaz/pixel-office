import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./employee.js";
import { isObject, readJsonSafe, removeWithBackup, writeJsonAtomicSync } from "./fsutil.js";

interface State {
  sessions: Record<string, string>;
  meta: Record<string, Record<string, unknown>>;
}

export class Store {
  private statePath: string;
  private historyDir: string;
  private attachmentsDir: string;
  private state: State;

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
    removeWithBackup(path.join(this.historyDir, `${id}.json`));
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

  // Saved on every chat line, so without fsync (still atomic, with a .bak): an fsync here blocked the office for ~10 ms per
  // line while employees streamed. Board, state and config keep their fsync.
  saveHistory(id: string, history: ChatMessage[]) {
    writeJsonAtomicSync(path.join(this.historyDir, `${id}.json`), history, { durable: false });
  }
}
