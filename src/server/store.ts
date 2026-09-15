import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./employee.js";

interface State {
  sessions: Record<string, string>;
  meta: Record<string, Record<string, unknown>>;
}

export class Store {
  private statePath: string;
  private historyDir: string;
  private state: State;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.statePath = path.join(dataDir, "state.json");
    this.historyDir = path.join(dataDir, "history");
    fs.mkdirSync(this.historyDir, { recursive: true });
    const loaded = fs.existsSync(this.statePath) ? JSON.parse(fs.readFileSync(this.statePath, "utf8")) : {};
    this.state = { sessions: loaded.sessions ?? {}, meta: loaded.meta ?? {} };
  }

  private save() {
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
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
    try { fs.unlinkSync(path.join(this.historyDir, `${id}.json`)); } catch {}
  }

  loadHistory(id: string): ChatMessage[] {
    const p = path.join(this.historyDir, `${id}.json`);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : [];
  }

  saveHistory(id: string, history: ChatMessage[]) {
    fs.writeFileSync(path.join(this.historyDir, `${id}.json`), JSON.stringify(history));
  }
}
