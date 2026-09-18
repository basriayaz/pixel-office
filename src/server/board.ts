import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

export type TaskStatus = "todo" | "doing" | "review" | "done" | "blocked";
export const TASK_STATUSES: readonly TaskStatus[] = ["todo", "doing", "review", "done", "blocked"];

export interface Task {
  id: number;
  title: string;
  detail: string;
  owner: string;      // employee id
  status: TaskStatus;
  createdBy: string;  // employee id or "user"
  created: number;
  updated: number;
  notes: Array<{ ts: number; by: string; text: string }>;
  review?: boolean;   // the owner cannot close it: "done" from the owner becomes "review" until the boss or the project manager approves
}

export interface Note {
  id: number;
  by: string;         // employee id or "user"
  byName: string;
  title: string;
  text: string;
  tags: string[];
  ts: number;
}

interface BoardData { nextTask: number; nextNote: number; tasks: Task[]; notes: Note[] }

// The office's shared space: a notebook everybody writes important findings into, and the task list
// the project manager (or the boss) assigns work through. One JSON file per office; every change emits "change".
export class Board extends EventEmitter {
  private file: string;
  private data: BoardData;

  constructor(dataDir: string) {
    super();
    this.file = path.join(dataDir, "board.json");
    let loaded: Partial<BoardData> = {};
    try { loaded = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch {}
    this.data = { nextTask: loaded.nextTask ?? 1, nextNote: loaded.nextNote ?? 1, tasks: loaded.tasks ?? [], notes: loaded.notes ?? [] };
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data));
    this.emit("change");
  }

  get tasks(): Task[] { return this.data.tasks; }
  get notes(): Note[] { return this.data.notes; }
  state() { return { tasks: this.data.tasks, notes: this.data.notes }; }

  // ---- notebook ----
  addNote(by: string, byName: string, title: string, text: string, tags: string[] = []): Note {
    const note: Note = { id: this.data.nextNote++, by, byName, title: title.trim().slice(0, 140), text: text.trim().slice(0, 12000), tags: tags.map((x) => x.trim().toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 8), ts: Date.now() };
    this.data.notes.push(note);
    this.save();
    return note;
  }

  updateNote(id: number, patch: { title?: string; text?: string; tags?: string[] }): Note | undefined {
    const n = this.data.notes.find((x) => x.id === id);
    if (!n) return undefined;
    if (patch.title !== undefined) n.title = patch.title.trim().slice(0, 140);
    if (patch.text !== undefined) n.text = patch.text.trim().slice(0, 12000);
    if (patch.tags) n.tags = patch.tags.map((x) => x.trim().toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 8);
    n.ts = Date.now();
    this.save();
    return n;
  }

  // A note that already says (nearly) the same thing, judged by its title: same words, or most words shared.
  similarNote(title: string): Note | undefined {
    const words = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2));
    const a = words(title);
    if (!a.size) return undefined;
    return this.data.notes.find((n) => {
      const b = words(n.title);
      let same = 0;
      for (const w of a) if (b.has(w)) same++;
      return same / Math.max(1, new Set([...a, ...b]).size) >= 0.7;
    });
  }

  deleteNote(id: number): boolean {
    const i = this.data.notes.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.data.notes.splice(i, 1);
    this.save();
    return true;
  }

  // ---- tasks ----
  addTask(owner: string, title: string, detail: string, createdBy: string, review = false): Task {
    const now = Date.now();
    const task: Task = { id: this.data.nextTask++, title: title.trim().slice(0, 160), detail: detail.trim().slice(0, 8000), owner, status: "todo", createdBy, created: now, updated: now, notes: [], ...(review ? { review: true } : {}) };
    this.data.tasks.push(task);
    this.save();
    return task;
  }

  updateTask(id: number, patch: { status?: TaskStatus; owner?: string; title?: string; detail?: string; note?: string; review?: boolean }, by: string): Task | undefined {
    const task = this.data.tasks.find((x) => x.id === id);
    if (!task) return undefined;
    if (patch.status && TASK_STATUSES.includes(patch.status)) task.status = patch.status;
    if (patch.owner) task.owner = patch.owner;
    if (patch.title !== undefined) task.title = patch.title.trim().slice(0, 160) || task.title;
    if (patch.detail !== undefined) task.detail = patch.detail.trim().slice(0, 8000);
    if (patch.review !== undefined) { if (patch.review) task.review = true; else delete task.review; }
    if (patch.note?.trim()) task.notes.push({ ts: Date.now(), by, text: patch.note.trim().slice(0, 2000) });
    task.updated = Date.now();
    this.save();
    return task;
  }

  deleteTask(id: number): boolean {
    const i = this.data.tasks.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.data.tasks.splice(i, 1);
    this.save();
    return true;
  }
}
