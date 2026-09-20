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
  after?: number[];   // tasks that must be done before this one can start
  autoStart?: string; // a start was approved (by this employee id or "user") while prerequisites were open: it begins by itself once they are done
  session?: string;   // the Claude session this task runs in, so a task sent back from review continues where it stopped
  kind?: "discovery"; // research only: looks, compares, proposes ideas; changes nothing in the project
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

export type IdeaStatus = "new" | "later" | "rejected" | "moved";
export const IDEA_STATUSES: readonly IdeaStatus[] = ["new", "later", "rejected", "moved"];
export type Effort = "S" | "M" | "L";

// A suggestion, not work: "the rival has X", "this would be nicer". It becomes a task only when the boss moves it to the board
// (or tells the project manager to).
export interface Idea {
  id: number;
  by: string;          // employee id or "user"
  byName: string;
  title: string;
  text: string;        // why it is worth doing, and what it rests on (rival, note numbers, numbers)
  effort?: Effort;     // rough size: S = hours, M = a day or two, L = more
  owner?: string;      // who would do it (employee id), a suggestion
  tags: string[];
  status: IdeaStatus;
  taskId?: number;     // the task it became
  comment?: string;    // the boss's word on it ("later: after launch")
  rank?: number;       // the project manager's order of doing: 1 = first
  advice?: string;     // the project manager's word on it (why, what it depends on, or why not)
  ts: number;
}

// Something with (nearly) the same title: same words, or most words shared.
function similarTitle<T extends { title: string }>(items: T[], title: string): T | undefined {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2));
  const a = words(title);
  if (!a.size) return undefined;
  return items.find((n) => {
    const b = words(n.title);
    let same = 0;
    for (const w of a) if (b.has(w)) same++;
    return same / Math.max(1, new Set([...a, ...b]).size) >= 0.7;
  });
}

interface BoardData { nextTask: number; nextNote: number; nextIdea: number; tasks: Task[]; notes: Note[]; ideas: Idea[] }

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
    this.data = { nextTask: loaded.nextTask ?? 1, nextNote: loaded.nextNote ?? 1, nextIdea: loaded.nextIdea ?? 1, tasks: loaded.tasks ?? [], notes: loaded.notes ?? [], ideas: loaded.ideas ?? [] };
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data));
    this.emit("change");
  }

  get tasks(): Task[] { return this.data.tasks; }
  get notes(): Note[] { return this.data.notes; }
  get ideas(): Idea[] { return this.data.ideas; }
  state() { return { tasks: this.data.tasks, notes: this.data.notes, ideas: this.data.ideas }; }

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
  similarNote(title: string): Note | undefined { return similarTitle(this.data.notes, title); }

  // ---- ideas ----
  similarIdea(title: string): Idea | undefined { return similarTitle(this.data.ideas.filter((x) => x.status !== "rejected"), title); }

  addIdea(by: string, byName: string, input: { title: string; text: string; effort?: Effort; owner?: string; tags?: string[] }): Idea {
    const idea: Idea = { id: this.data.nextIdea++, by, byName, title: input.title.trim().slice(0, 160), text: input.text.trim().slice(0, 4000), ...(input.effort ? { effort: input.effort } : {}), ...(input.owner ? { owner: input.owner } : {}), tags: (input.tags ?? []).map((x) => x.trim().toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 6), status: "new", ts: Date.now() };
    this.data.ideas.push(idea);
    this.save();
    return idea;
  }

  updateIdea(id: number, patch: { title?: string; text?: string; effort?: Effort | null; owner?: string | null; status?: IdeaStatus; comment?: string; taskId?: number; rank?: number | null; advice?: string }): Idea | undefined {
    const idea = this.data.ideas.find((x) => x.id === id);
    if (!idea) return undefined;
    if (patch.title !== undefined) idea.title = patch.title.trim().slice(0, 160) || idea.title;
    if (patch.text !== undefined) idea.text = patch.text.trim().slice(0, 4000);
    if (patch.effort !== undefined) { if (patch.effort) idea.effort = patch.effort; else delete idea.effort; }
    if (patch.owner !== undefined) { if (patch.owner) idea.owner = patch.owner; else delete idea.owner; }
    if (patch.status && IDEA_STATUSES.includes(patch.status)) idea.status = patch.status;
    if (patch.comment !== undefined) { if (patch.comment.trim()) idea.comment = patch.comment.trim().slice(0, 600); else delete idea.comment; }
    if (patch.taskId !== undefined) idea.taskId = patch.taskId;
    if (patch.rank !== undefined) { if (patch.rank && patch.rank > 0) idea.rank = Math.round(patch.rank); else delete idea.rank; }
    if (patch.advice !== undefined) { if (patch.advice.trim()) idea.advice = patch.advice.trim().slice(0, 600); else delete idea.advice; }
    this.save();
    return idea;
  }

  deleteIdea(id: number): boolean {
    const i = this.data.ideas.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.data.ideas.splice(i, 1);
    this.save();
    return true;
  }

  // An idea becomes a task; the idea stays, pointing at it, so nobody proposes it again.
  promoteIdea(id: number, owner: string, createdBy: string, opts: { detail?: string; review?: boolean; after?: number[] } = {}): Task | undefined {
    const idea = this.data.ideas.find((x) => x.id === id);
    if (!idea || idea.status === "moved") return undefined;
    const detail = (opts.detail?.trim() || idea.text) + `\n\n(💡 #${idea.id} · ${idea.byName})`;
    const task = this.addTask(owner, idea.title, detail, createdBy, !!opts.review, opts.after ?? []);
    this.updateIdea(id, { status: "moved", taskId: task.id });
    return task;
  }

  deleteNote(id: number): boolean {
    const i = this.data.notes.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.data.notes.splice(i, 1);
    this.save();
    return true;
  }

  // ---- tasks ----
  addTask(owner: string, title: string, detail: string, createdBy: string, review = false, after: number[] = [], kind?: "discovery"): Task {
    const now = Date.now();
    const deps = [...new Set(after)].filter((id) => this.data.tasks.some((x) => x.id === id));
    const task: Task = { id: this.data.nextTask++, title: title.trim().slice(0, 160), detail: detail.trim().slice(0, 8000), owner, status: "todo", createdBy, created: now, updated: now, notes: [], ...(review ? { review: true } : {}), ...(deps.length ? { after: deps } : {}), ...(kind ? { kind } : {}) };
    this.data.tasks.push(task);
    this.save();
    return task;
  }

  // Prerequisites of a task that are not done yet (deleted ones do not hold anything up).
  waitingOn(task: Task): number[] {
    return (task.after ?? []).filter((id) => { const d = this.data.tasks.find((x) => x.id === id); return d && d.status !== "done"; });
  }

  // Bookkeeping that is not a change of the task itself: no "updated" stamp.
  markTask(id: number, patch: { autoStart?: string | null; session?: string | null }) {
    const task = this.data.tasks.find((x) => x.id === id);
    if (!task) return;
    if (patch.autoStart !== undefined) { if (patch.autoStart) task.autoStart = patch.autoStart; else delete task.autoStart; }
    if (patch.session !== undefined) { if (patch.session) task.session = patch.session; else delete task.session; }
    this.save();
  }

  updateTask(id: number, patch: { status?: TaskStatus; owner?: string; title?: string; detail?: string; note?: string; review?: boolean; after?: number[] }, by: string): Task | undefined {
    const task = this.data.tasks.find((x) => x.id === id);
    if (!task) return undefined;
    const prev = task.status;
    if (patch.status && TASK_STATUSES.includes(patch.status)) task.status = patch.status;
    if (patch.owner) task.owner = patch.owner;
    if (patch.title !== undefined) task.title = patch.title.trim().slice(0, 160) || task.title;
    if (patch.detail !== undefined) task.detail = patch.detail.trim().slice(0, 8000);
    if (patch.review !== undefined) { if (patch.review) task.review = true; else delete task.review; }
    if (patch.after) { const deps = [...new Set(patch.after)].filter((d) => d !== id && this.data.tasks.some((x) => x.id === d)); if (deps.length) task.after = deps; else delete task.after; }
    if (task.status !== "todo") delete task.autoStart;
    if (patch.note?.trim()) task.notes.push({ ts: Date.now(), by, text: patch.note.trim().slice(0, 2000) });
    task.updated = Date.now();
    this.save();
    if (task.status !== prev) this.emit("status", task, prev, by); // the office reacts: prerequisites met, digest for the project manager
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
