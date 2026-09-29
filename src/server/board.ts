import path from "node:path";
import { EventEmitter } from "node:events";
import { isObject, readJsonSafe, writeJsonAtomicSync } from "./fsutil.js";

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
  rev?: number;        // bumped by every change of title, text, effort, owner, status or comment: an edit made on an older rev is refused
  updated?: number;
  edits?: IdeaEdit[];  // what the proposer changed while talking it over with the boss, newest last (shown to the boss)
}

export interface IdeaEdit { ts: number; by: string; byName: string; summary: string; fields: Array<"title" | "text" | "effort" | "owner"> }
export type IdeaEditResult =
  | { ok: true; idea: Idea; edit: IdeaEdit }
  | { ok: false; reason: "missing" | "closed" | "conflict" | "unchanged"; idea?: Idea };

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
    // Never start empty over a board that merely failed to parse: the .bak is tried first, and a file that cannot be
    // read at all is moved aside (board.json.corrupt-<ts>) before an empty board is started, so no save can overwrite it.
    const loaded = readJsonSafe<Partial<BoardData>>(this.file, () => ({}), { validate: isObject, label: "board" });
    const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
    this.data = { nextTask: loaded.nextTask ?? 1, nextNote: loaded.nextNote ?? 1, nextIdea: loaded.nextIdea ?? 1, tasks: list(loaded.tasks), notes: list(loaded.notes), ideas: list(loaded.ideas) };
  }

  private save() {
    writeJsonAtomicSync(this.file, this.data);
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
  similarIdea(title: string): Idea | undefined { return similarTitle(this.data.ideas.filter((x) => x.status !== "rejected" && x.status !== "moved"), title); }
  // Rejected or already-moved ideas that overlap the new one by keywords (title + text), so a closed idea is not proposed again blindly.
  similarClosedIdea(title: string, text: string): Idea | undefined {
    const words = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 3));
    const a = words(title.replace(/^\s*revize\s*#\d+\s*[:\-–—]?\s*/i, ""));
    const ctx = words(text);
    let best: Idea | undefined, bestScore = 0;
    for (const x of this.data.ideas) {
      if (x.status !== "rejected" && x.status !== "moved") continue;
      const b = words(x.title);
      if (a.size < 2 || b.size < 2) continue;
      let same = 0;
      for (const w of a) if (b.has(w)) same++;
      let ctxSame = 0;
      for (const w of b) if (ctx.has(w) && !a.has(w)) ctxSame++;
      const score = (same + ctxSame * 0.5) / Math.min(a.size, b.size);
      if (same >= 2 && score >= 0.6 && score > bestScore) { best = x; bestScore = score; }
    }
    return best;
  }

  addIdea(by: string, byName: string, input: { title: string; text: string; effort?: Effort; owner?: string; tags?: string[] }): Idea {
    const idea: Idea = { id: this.data.nextIdea++, by, byName, title: input.title.trim().slice(0, 160), text: input.text.trim().slice(0, 4000), ...(input.effort ? { effort: input.effort } : {}), ...(input.owner ? { owner: input.owner } : {}), tags: (input.tags ?? []).map((x) => x.trim().toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 6), status: "new", ts: Date.now() };
    this.data.ideas.push(idea);
    this.save();
    this.emit("idea", idea); // for the activity log
    return idea;
  }

  updateIdea(id: number, patch: { title?: string; text?: string; effort?: Effort | null; owner?: string | null; status?: IdeaStatus; comment?: string; taskId?: number; rank?: number | null; advice?: string }): Idea | undefined {
    const idea = this.data.ideas.find((x) => x.id === id);
    if (!idea) return undefined;
    const before = JSON.stringify([idea.title, idea.text, idea.effort, idea.owner, idea.status, idea.comment]);
    if (patch.title !== undefined) idea.title = patch.title.trim().slice(0, 160) || idea.title;
    if (patch.text !== undefined) idea.text = patch.text.trim().slice(0, 4000);
    if (patch.effort !== undefined) { if (patch.effort) idea.effort = patch.effort; else delete idea.effort; }
    if (patch.owner !== undefined) { if (patch.owner) idea.owner = patch.owner; else delete idea.owner; }
    if (patch.status && IDEA_STATUSES.includes(patch.status)) idea.status = patch.status;
    if (patch.comment !== undefined) { if (patch.comment.trim()) idea.comment = patch.comment.trim().slice(0, 600); else delete idea.comment; }
    if (patch.taskId !== undefined) idea.taskId = patch.taskId;
    if (patch.rank !== undefined) { if (patch.rank && patch.rank > 0) idea.rank = Math.round(patch.rank); else delete idea.rank; }
    if (patch.advice !== undefined) { if (patch.advice.trim()) idea.advice = patch.advice.trim().slice(0, 600); else delete idea.advice; }
    if (before !== JSON.stringify([idea.title, idea.text, idea.effort, idea.owner, idea.status, idea.comment])) { idea.rev = (idea.rev ?? 0) + 1; idea.updated = Date.now(); }
    this.save();
    return idea;
  }

  // The proposer reworks their own idea while talking it over with the boss. Refused when the idea changed since `rev`
  // (the boss or somebody else edited it meanwhile) or is no longer open; never moves or starts it.
  editIdea(id: number, rev: number, patch: { title?: string; text?: string; effort?: Effort; owner?: string }, who: { by: string; byName: string; summary: string }): IdeaEditResult {
    const idea = this.data.ideas.find((x) => x.id === id);
    if (!idea) return { ok: false, reason: "missing" };
    if (idea.status === "moved" || idea.status === "rejected") return { ok: false, reason: "closed", idea };
    if ((idea.rev ?? 0) !== rev) return { ok: false, reason: "conflict", idea };
    const next = { title: patch.title?.trim().slice(0, 160) || undefined, text: patch.text?.trim().slice(0, 4000) || undefined, effort: patch.effort, owner: patch.owner };
    const fields = (["title", "text", "effort", "owner"] as const).filter((f) => next[f] !== undefined && next[f] !== idea[f]);
    if (!fields.length) return { ok: false, reason: "unchanged", idea };
    const edit: IdeaEdit = { ts: Date.now(), by: who.by, byName: who.byName, summary: who.summary.trim().slice(0, 600), fields: [...fields] };
    idea.edits = [...(idea.edits ?? []), edit].slice(-20);
    this.updateIdea(id, Object.fromEntries(fields.map((f) => [f, next[f]])));
    this.emit("ideaEdited", idea, edit);
    return { ok: true, idea, edit };
  }

  deleteIdea(id: number): boolean {
    const i = this.data.ideas.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.data.ideas.splice(i, 1);
    this.save();
    return true;
  }

  // An idea becomes a task; the idea stays, pointing at it, so nobody proposes it again.
  promoteIdea(id: number, owner: string, createdBy: string, opts: { detail?: string; review?: boolean; after?: number[]; commentLabel?: string } = {}): Task | undefined {
    const idea = this.data.ideas.find((x) => x.id === id);
    if (!idea || idea.status === "moved") return undefined;
    // the boss's word on the idea goes with it: it is often the very condition the work has to meet
    const detail = (opts.detail?.trim() || idea.text) + (idea.comment ? `\n\n${opts.commentLabel ?? "Boss"}: ${idea.comment}` : "") + `\n\n(💡 #${idea.id} · ${idea.byName})`;
    const task = this.addTask(owner, idea.title, detail, createdBy, !!opts.review, opts.after ?? []);
    this.updateIdea(id, { status: "moved", taskId: task.id });
    this.emit("promoted", idea, task, createdBy);
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
    this.emit("added", task);
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
    const prev = task.status, prevOwner = task.owner;
    const before = JSON.stringify([task.title, task.detail, !!task.review, task.after ?? []]);
    if (patch.status && TASK_STATUSES.includes(patch.status)) task.status = patch.status;
    if (patch.owner) task.owner = patch.owner;
    if (patch.title !== undefined) task.title = patch.title.trim().slice(0, 160) || task.title;
    if (patch.detail !== undefined) task.detail = patch.detail.trim().slice(0, 8000);
    if (patch.review !== undefined) { if (patch.review) task.review = true; else delete task.review; }
    if (patch.after) { const deps = [...new Set(patch.after)].filter((d) => d !== id && this.data.tasks.some((x) => x.id === d)); if (deps.length) task.after = deps; else delete task.after; }
    const edited = before !== JSON.stringify([task.title, task.detail, !!task.review, task.after ?? []]);
    if (task.status !== "todo") delete task.autoStart;
    if (patch.note?.trim()) task.notes.push({ ts: Date.now(), by, text: patch.note.trim().slice(0, 2000) });
    task.updated = Date.now();
    this.save();
    if (task.owner !== prevOwner || edited) this.emit("edited", task, { owner: task.owner !== prevOwner ? prevOwner : undefined, edited }, by);
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
