import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type PermissionResult,
  type PermissionUpdate,
  type PermissionMode,
  type HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "./store.js";
import { t, tget, getSettings } from "./runtime.js";
import { officeServer, OFFICE_TOOLS, type Colleagues } from "./office-tools.js";
import { runCodexTurn, codexCostOf, skillsIndex, skillFile, type CodexItem } from "./codex.js";
import { runGeminiTurn, type GeminiEvent } from "./gemini.js";
import { engineOf, geminiKey, openrouterEnv, openrouterSlug, markAuthFailed, AUTH_ERROR, type Engine } from "./providers.js";
import { listSkills, listProjectSkills } from "./agents.js";
import { fromClaudeRateLimit, fromClaudeUsage, fromCodexThread, claudeUsageDue } from "./quota.js";
import type { CostKind } from "./ledger.js";

export type Status = "idle" | "working" | "waiting" | "error" | "sick";

export interface EmployeeConfig {
  id: string;
  officeId: string;
  name: string;
  role: string;
  color: string;
  look: Record<string, unknown>;
  systemPrompt: string;
  cwd: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  model?: string;
  settingSources?: Array<"user" | "project" | "local">;
  memoryFile?: string;
  pluginDir?: string;
  dir?: string;
  agentFile?: string;
  refreshHours?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  hired?: string;
  manager?: boolean; // project manager: sees everybody's activity and assigns tasks
  worktree?: boolean; // works in a private git worktree (branch po/<id>) so parallel code changes cannot collide
  baseCwd?: string;   // the configured working folder; `cwd` is the worktree inside it when `worktree` is on
  connectorsOff?: string[]; // claude.ai connectors (by server name) this employee does not get; all others come along by default
  autoRefresh?: boolean;    // the timed knowledge refresh runs for this employee (off unless switched on: it spends tokens nobody asked for)
}

export interface Connector { name: string; status: string; tools: number | null }

// The claude.ai connectors of the account the office runs on. Asked from a Claude process that never gets a message, so it costs no tokens.
let connectorCache: { at: number; list: Connector[] } | undefined;
let connectorProbe: Promise<Connector[]> | undefined;
export function listConnectors(cwd: string, fresh = false): Promise<Connector[]> {
  if (!fresh && connectorCache && Date.now() - connectorCache.at < 5 * 60e3) return Promise.resolve(connectorCache.list);
  return (connectorProbe ??= (async () => {
    let release = () => {};
    const silent = (async function* (): AsyncGenerator<SDKUserMessage> { await new Promise<void>((r) => (release = r)); })();
    const q = query({ prompt: silent, options: { cwd, settingSources: [], persistSession: false } });
    try {
      let servers = await q.mcpServerStatus();
      for (let i = 0; i < 6 && (!servers.length || servers.some((x) => x.status === "pending")); i++) { await new Promise((r) => setTimeout(r, 1500)); servers = await q.mcpServerStatus(); }
      const list = servers.filter((x) => x.scope === "claudeai").map((x) => ({ name: x.name, status: x.status, tools: x.tools?.length ?? null }));
      connectorCache = { at: Date.now(), list };
      return list;
    } catch { return connectorCache?.list ?? []; }
    finally { release(); connectorProbe = undefined; }
  })());
}

export interface ChatMessage {
  role: "user" | "assistant" | "activity" | "system" | "auto" | "colleague" | "meeting";
  text: string;
  ts: number;
  from?: string;
  images?: string[]; // URLs of pasted images shown with the message
  id?: string;       // boss messages: lets the client refer to one (undo while it is queued)
  queued?: boolean;  // a boss message waiting for the running turn to end; not seen by any model yet
  ideaId?: number;   // a boss message about this idea (asked from its card): delivered on its own, only to the chat session
}

export interface ImageInput {
  media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string; // base64
}

export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);


// What one finished turn spent, for the office's cost ledger (the running `cost` resets with the employee, the ledger never does).
export interface Spend { cost: number; kind: CostKind; task?: number; model: string; engine: Engine; tokens?: { input: number; output: number; cached?: number } }

export interface AskRequest {
  requestId: string;
  kind: "permission" | "question";
  toolName: string;
  title: string;
  description?: string;
  input: Record<string, unknown>;
  canAlwaysAllow: boolean;
}

export interface ReplyDecision {
  allow: boolean;
  always?: boolean;
  answers?: Record<string, unknown>;
}

interface PendingAsk {
  request: AskRequest;
  suggestions?: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
}

const userMsg = (text: string, images?: ImageInput[]): SDKUserMessage => ({
  type: "user",
  message: {
    role: "user",
    content: images?.length
      ? [
          ...images.map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.media_type, data: im.data } })),
          ...(text ? [{ type: "text" as const, text }] : []),
        ]
      : text,
  },
  parent_tool_use_id: null,
});

// The text of a message, without its images.
const plainText = (m: SDKUserMessage): string =>
  typeof m.message.content === "string" ? m.message.content : m.message.content.map((b) => ("text" in b ? b.text : "")).filter(Boolean).join("\n");

// A string that may not be in the locale files yet: the English text stands in until it is added.
function tt(key: string, fallback: string, vars: Record<string, string | number> = {}): string {
  if (typeof tget(key) === "string") return t(key, vars);
  return fallback.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A memory file is paid for in every session; past this size the employee is asked to condense it.
const MEMORY_SOFT_LIMIT = 8000;

// Where a message is delivered: the employee's chat session, the running board task's own session, or the throw-away refresh session.
type Target = "chat" | "task" | "side";
// A boss message waiting for the running turn to end. It is already in the chat history (flagged `queued`) so the boss sees it.
interface QueuedBoss { id: string; text: string; ts: number; auto: boolean; images?: ImageInput[]; files?: string[]; entry: ChatMessage; ideaId?: number }
// What the client is told about the queue. `task`: the task session it will go to (never for a message about an idea).
export interface QueuedInfo { id: string; text: string; ts: number; images?: string[]; task: number | null; ideaId?: number }

// Pasted images read back from their attachment files (a queued message restored after a restart).
const EXT_TYPES: Record<string, ImageInput["media_type"]> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
function imagesFromFiles(files?: string[]): ImageInput[] | undefined {
  const out: ImageInput[] = [];
  for (const f of files ?? []) {
    const media_type = EXT_TYPES[path.extname(f).toLowerCase()];
    if (!media_type) continue;
    try { out.push({ media_type, data: fs.readFileSync(f).toString("base64") }); } catch {}
  }
  return out.length ? out : undefined;
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const taskOf = (key?: string) => (key?.startsWith("task:") ? Number(key.slice(5)) : undefined);

export class Employee extends EventEmitter {
  status: Status = "idle";
  history: ChatMessage[];
  sessionId?: string;
  cost = 0;
  context = 0; // tokens in the model's window at its last call: what every further step of this conversation costs to re-read
  model?: string;
  lastActivity = 0;
  lastBossAt = 0; // when the boss last wrote to this employee (for "do not refresh while the boss is around")
  sickUntil = 0;
  inMeeting = false;
  private sickTimer?: NodeJS.Timeout;
  private meetingTurn = false;
  private preamble = ""; // told to the model with the next chat message (e.g. "the meeting is over")

  private q?: Query;
  private cx?: { kill: () => void };  // the Codex engine: one process per turn, present while its loop runs
  private runningFor?: string;        // the session the running process belongs to: "chat", "task:<id>" or "side"
  private plain = new WeakMap<SDKUserMessage, { text: string; files: string[] }>(); // what a message is for an engine that takes text and image files
  private gmInstr = new Map<string, string>(); // Gemini: the instructions a session last saw (hash), so they are resent only when changed
  private cxTokens = new Map<string, number>(); // Codex reports usage summed over the whole thread: last total per thread
  private inbox: SDKUserMessage[] = [];
  private carry: SDKUserMessage[] = []; // taken out of the inbox of a process that was closed: they go to the next one
  private wake?: () => void;
  private generation = 0;
  private pending = new Map<string, PendingAsk>();
  private streamText = "";
  private unanswered: SDKUserMessage[] = []; // delivered in the turn that is running now and not answered yet
  private turnOpen = false;                  // a delivered message has not had its result yet
  private turnEndWaiters: Array<() => void> = [];
  private recovered = false;
  private interrupting = false;
  private interruptJob?: { resume: boolean; done: Promise<void> };
  private disposed = false;
  private colleagues?: Colleagues;
  private turnTexts: string[] = [];
  // A Claude process reports its cost as a running total, and a resumed session starts from the total its transcript saved:
  // the turn's own cost is the difference to the last total seen for that session.
  private procPrev = 0;
  private procFirst = true;
  private turnSpend?: { cost: number; tokens?: Spend["tokens"] };
  private taskId?: number; // the board task being worked on, in a clean session of its own
  private taskQueue: Array<{ id: number; from?: Employee }> = [];
  private taskNotesSeen = new Map<number, number>(); // task id -> how many notes it had when this employee last began it
  private taskTalk: string[] = [];  // what the boss said inside the task session, and the answers: handed to the chat when the task ends
  private taskTalkFor?: number;
  private taskTurnHasBoss = false;
  private turnIdea?: number; // the idea the running chat turn is about: the only one edit_idea may change in it
  private side?: "refresh"; // a throw-away session that leaves no trace in the chat session
  private refreshPrev?: number; // lastRefresh before this refresh: put back when the boss cancels it, so it runs again later
  private bossQueue: QueuedBoss[] = []; // boss messages held until the running turn ends (never dropped into the middle of a turn)
  private held: Array<{ from: Employee; text: string; resolve?: (reply: string) => void }> = []; // colleague messages waiting for the running turn to end
  private autoQueue: Array<{ text: string; still?: () => boolean }> = []; // office messages (e.g. "discovery round") that wait for a free moment instead of cutting into a turn
  private digest: string[] = []; // board news for the project manager, handed over with the next message instead of costing a turn each
  private pendingRestart = false;       // new settings wait for the end of the running turn
  private pendingEngineSwitch = false;
  private recapNext?: string;           // the chat session is new: the next chat message carries a recap of the chat (the reason)
  private compacting = false;
  private announced: Status = "idle"; // the status listeners last heard

  constructor(public cfg: EmployeeConfig, private store: Store) {
    super();
    this.history = store.loadHistory(cfg.id);
    this.sessionId = store.getSession(cfg.id);
    this.cost = store.getMeta<number>(cfg.id, "cost") ?? 0;
    this.lastActivity = [...this.history].reverse().find((m) => m.role === "user" || m.role === "assistant")?.ts ?? 0;
    this.lastBossAt = [...this.history].reverse().find((m) => m.role === "user")?.ts ?? 0;
    // boss messages that were still waiting when the office stopped: they wait again and go out with the next delivery
    // (index.ts pokes every employee with a restored queue once the office is up). Pasted images are read back from their
    // attachment files: the Claude engine takes them inline, Codex by file.
    for (const m of this.history) if (m.queued && m.id) {
      const files = this.filesOf(m.images);
      this.bossQueue.push({ id: m.id, text: m.text, ts: m.ts, auto: m.role === "auto", entry: m, files, images: imagesFromFiles(files), ...(m.ideaId ? { ideaId: m.ideaId } : {}) });
    }
  }

  get pendingAsks(): AskRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  get engine(): Engine { return engineOf(this.cfg.model); }
  private get running() { return !!this.q || !!this.cx; }
  get busy() { return this.status === "working" || this.status === "waiting"; }
  get currentTask() { return this.taskId; }
  // The idea the turn that runs now was asked about (its card's chat), if any.
  get ideaTurn() { return this.turnIdea; }
  // This employee has the board task in hand: working on it (or holding its session between turns), or queued to begin it.
  holdsTask(id: number) { return this.taskId === id || this.taskQueue.some((q) => q.id === id); }
  get hasOfficeMessages() { return this.autoQueue.length > 0; }
  get hasNews() { return this.digest.length > 0; }
  get isCompacting() { return this.compacting; }
  // Boss messages waiting for the running turn to end, oldest first.
  get queue(): QueuedInfo[] {
    return this.bossQueue.map((b) => ({ id: b.id, text: b.text, ts: b.ts, ...(b.entry.images?.length ? { images: b.entry.images } : {}), task: b.ideaId ? null : this.taskId ?? null, ...(b.ideaId ? { ideaId: b.ideaId } : {}) }));
  }

  // The automatic refresh may start: nothing runs or waits, and the boss has been quiet for `quietMs`.
  canAutoRefresh(quietMs: number, now = Date.now()): boolean {
    return !this.busy && !this.sick && !this.inMeeting && !this.side && this.taskId === undefined && !this.bossQueue.length && now - this.lastBossAt >= quietMs;
  }

  // ---- routing: every decision about where a message goes is made here ----
  // "hold" = wait for the end of the running turn (or the meeting, or the recovery); "task" = the board task's own session;
  // "chat" = the chat session. A task session that is finished is closed on the way, so what follows goes to the chat.
  // A message about an idea never goes into a task session: it waits until the task is let go.
  private routeFor(kind: "boss" | "idea" | "colleague" | "office" | "meeting"): "hold" | "chat" | "task" {
    if (kind === "meeting") return this.busy ? "hold" : "chat"; // meetings always talk in the chat session
    if (this.sick || this.inMeeting || this.busy) return "hold";
    this.leaveFinishedTask();
    if (this.taskId !== undefined) return kind === "office" || kind === "idea" ? "hold" : "task";
    return "chat";
  }

  // The one place a message is handed to an engine. A process that belongs to another session is closed first
  // (whatever it had not taken yet is carried over to the next one).
  private dispatch(target: Target, text: string, o: { images?: ImageInput[]; files?: string[]; preamble?: boolean; ideaId?: number } = {}) {
    const key = target === "task" ? `task:${this.taskId}` : target;
    this.turnIdea = target === "chat" ? o.ideaId : undefined;
    if (!this.turnOpen) this.applyPending();
    if (this.running && this.runningFor !== key) this.stopQuery();
    const msg = userMsg((o.preamble ? this.takePreamble() : "") + text, o.images);
    if (o.files?.length) this.plain.set(msg, { text: "", files: o.files });
    if (!this.sick) this.setStatus("working");
    this.turnOpen = true;
    this.unanswered.push(msg);
    this.enqueue(msg);
    if (!this.running) this.start(key);
  }

  // `ideaId`: the boss asks about that idea (from its card). The office adds the idea as it stands at delivery.
  send(text: string, auto = false, images?: ImageInput[], ideaId?: number) {
    const urls = images?.map((im) => {
      const name = this.store.saveAttachment(this.cfg.id, Buffer.from(im.data, "base64"), im.media_type.split("/")[1].replace("jpeg", "jpg"));
      return `/attachments/${encodeURIComponent(this.cfg.officeId)}/${encodeURIComponent(this.cfg.id)}/${name}`;
    });
    const entry: ChatMessage = { role: auto ? "auto" : "user", text, ts: Date.now(), id: newId(), ...(urls?.length ? { images: urls } : {}), ...(ideaId ? { ideaId } : {}) };
    const item: QueuedBoss = { id: entry.id!, text, ts: entry.ts, auto, images, files: this.filesOf(urls), entry, ...(ideaId ? { ideaId } : {}) };
    if (!auto) {
      this.lastBossAt = entry.ts;
      // the boss comes first: a refresh can always be done again later, a lost message cannot
      if (this.side) this.abandonSide();
    }
    const route = this.routeFor(ideaId ? "idea" : "boss");
    // with others still waiting it may not go out in this delivery: shown as waiting, deliverBoss clears what it takes
    if (route === "hold" || this.bossQueue.length) entry.queued = true;
    this.push(entry);
    this.bossQueue.push(item);
    if (route === "hold" || !this.deliverBoss(route)) this.emitQueue();
  }

  // Undo: a queued boss message is taken back before it was delivered.
  unqueue(msgId: string): boolean {
    const i = this.bossQueue.findIndex((b) => b.id === msgId);
    if (i < 0) return false;
    const [b] = this.bossQueue.splice(i, 1);
    const at = this.history.indexOf(b.entry);
    if (at >= 0) { this.history.splice(at, 1); this.store.saveHistory(this.cfg.id, this.history); }
    this.emit("message_removed", msgId);
    this.emitQueue();
    return true;
  }

  // What the boss queued goes out as one message, in the order it was written. Messages about an idea go out on their own:
  // never merged with other messages or with those about another idea, and never into a task session (they wait there).
  // False when nothing could go out.
  private deliverBoss(target: "chat" | "task"): boolean {
    let items: QueuedBoss[];
    if (target === "task") items = this.bossQueue.filter((b) => !b.ideaId);
    else {
      const key = this.bossQueue[0]?.ideaId;
      const n = this.bossQueue.findIndex((b) => b.ideaId !== key);
      items = this.bossQueue.slice(0, n < 0 ? undefined : n);
    }
    if (!items.length) return false;
    this.bossQueue = this.bossQueue.filter((b) => !items.includes(b));
    const ideaId = items[0].ideaId;
    let changed = false;
    for (const b of items) if (b.entry.queued) { delete b.entry.queued; changed = true; }
    if (changed) this.store.saveHistory(this.cfg.id, this.history);
    this.emitQueue();
    if (target === "task") {
      this.noteTaskTalk();
      for (const b of items) this.taskTalk.push(`${t("server.meeting.boss")}: ${b.text}`);
      this.taskTurnHasBoss = true;
    }
    const body = items.map((b) => b.text).filter(Boolean).join("\n\n");
    this.dispatch(target, ideaId ? this.ideaContext(ideaId) + "\n\n" + body : body, {
      images: items.flatMap((b) => b.images ?? []), files: items.flatMap((b) => b.files ?? []), preamble: target === "chat", ideaId,
    });
    return true;
  }

  // The idea as it stands now (not as it was when the boss wrote), and whether this employee may rework it with edit_idea.
  private ideaContext(id: number): string {
    const x = this.colleagues?.board().ideas.find((i) => i.id === id);
    if (!x) return t("server.ideas.chatGone", { id });
    const nameOf = (eid?: string) => (eid ? this.colleagues?.list().find((e) => e.cfg.id === eid)?.cfg.name ?? eid : "-");
    const open = x.status === "new" || x.status === "later";
    return t("server.ideas.chatContext", {
      id, rev: x.rev ?? 0, status: x.status, title: x.title, text: x.text || "-", effort: x.effort ?? "-", owner: nameOf(x.owner),
      by: x.by === "user" ? t("server.meeting.boss") : x.byName, comment: x.comment || "-",
    }) + "\n" + (x.by === this.cfg.id && open ? t("server.ideas.chatCanEdit", { id, rev: x.rev ?? 0 }) : t("server.ideas.chatNoEdit", { id }));
  }

  private emitQueue() { this.emit("queue", this.queue); }

  private filesOf(urls?: string[]): string[] | undefined {
    const files = urls?.map((u) => this.store.attachmentPath(this.cfg.id, decodeURIComponent(u.split("/").pop() ?? "")) ?? "").filter(Boolean);
    return files?.length ? files : undefined;
  }

  setColleagues(c: Colleagues) {
    this.colleagues = c;
  }

  // The office's data moved (e.g. one office became several): history, session and meta are written through the new store from now on.
  setStore(store: Store) {
    this.store = store;
  }

  // Activity line in this employee's chat (e.g. "forwarded to X").
  note(text: string) {
    this.push({ role: "activity", text, ts: Date.now() });
  }

  // A message from another employee; resolves with this employee's next reply when `wait` is set.
  // While a turn is running (or a meeting is on) it waits: a message dropped into the middle of a turn reaches the model
  // inside a tool result, where it looks like an injection and gets ignored. Everything that piled up arrives as one message.
  sendFromColleague(from: Employee, text: string, wait: boolean): Promise<string> {
    this.push({ role: "colleague", text, ts: Date.now(), from: from.cfg.name });
    const reply = wait ? new Promise<string>((resolve) => {
      let open = true;
      const once = (r: string) => { if (!open) return; open = false; clearTimeout(timer); resolve(r || t("server.office.noReply")); };
      const timer = setTimeout(() => once(""), 10 * 60e3);
      this.held.push({ from, text, resolve: once });
    }) : (this.held.push({ from, text }), Promise.resolve(""));
    this.deliverHeld();
    return reply;
  }

  private deliverHeld(): boolean {
    if (!this.held.length) return false;
    const route = this.routeFor("colleague");
    if (route === "hold") return false;
    const batch = this.held.splice(0);
    const waiters = batch.filter((h) => h.resolve);
    if (waiters.length) this.once("turn", (reply: string) => { for (const w of waiters) w.resolve!(reply); });
    const body = batch.map((h) => t("server.colleagueMsg", { name: h.from.cfg.name, role: h.from.cfg.role, text: h.text })).join("\n\n");
    this.dispatch(route, body + "\n\n" + t("server.colleagueRules"), { preamble: route === "chat" });
    return true;
  }

  // ---- board tasks: each one in a clean session ----
  // The chat session is never the place where long work piles up: what a step costs is the size of the conversation behind it.
  startTask(id: number, from?: Employee): "started" | "queued" {
    const k = this.colleagues?.board().tasks.find((x) => x.id === id);
    if (!getSettings().taskSessions && k) {
      this.colleagues!.board().updateTask(id, { status: "doing" }, from?.cfg.id ?? "user");
      const text = t("server.board.taskMessage", { id, title: k.title, detail: k.detail || "-" });
      if (from) void this.sendFromColleague(from, text, false); else this.send(text);
      return "started";
    }
    this.leaveFinishedTask();
    if (this.busy || this.sick || this.inMeeting || this.taskId !== undefined || this.side) {
      if (!this.taskQueue.some((q) => q.id === id)) this.taskQueue.push({ id, from });
      return "queued";
    }
    return this.beginTask(id, from) ? "started" : "queued";
  }

  private beginTask(id: number, from?: Employee): boolean {
    const board = this.colleagues?.board();
    const k = board?.tasks.find((x) => x.id === id);
    if (!board || !k || k.status === "done" || k.owner !== this.cfg.id) return false;
    this.taskId = id;
    if (this.taskTalkFor !== id) { this.taskTalk = []; this.taskTalkFor = id; }
    this.setStatus("working"); // before the board hears about it: its listeners must find this employee busy
    const back = k.session ? this.sendBackNote(k) : undefined; // sent back (e.g. from review): same session, plus what was said
    board.updateTask(id, { status: "doing" }, from?.cfg.id ?? "user");
    this.taskNotesSeen.set(id, k.notes.length);
    this.push({ role: "system", text: t(k.session ? "server.task.resumed" : "server.task.cleanSession", { id }), ts: Date.now() });
    const text = t("server.board.taskMessage", { id, title: k.title, detail: k.detail || "-" })
      + (k.kind === "discovery" ? "\n\n" + t("server.cycle.discoveryTask") : "")
      + (from ? "\n\n" + t("server.task.startedBy", { name: from.cfg.name }) : "")
      + (back ? "\n\n" + t("server.task.backWith", { note: back }) : "");
    this.push({ role: from ? "colleague" : "user", text, ts: Date.now(), ...(from ? { from: from.cfg.name } : {}) });
    this.dispatch("task", text);
    return true;
  }

  // The note a task came back with, if it really is one: written since this employee last began the task, by somebody else
  // (a reviewer, the boss), and not the office's own "stopped" or error line. A stop or a meeting pause is not a send-back.
  private sendBackNote(k: { id: number; notes: Array<{ by: string; text: string }> }): string | undefined {
    const last = k.notes[k.notes.length - 1];
    if (!last) return undefined;
    const seen = this.taskNotesSeen.get(k.id);
    if (seen !== undefined && k.notes.length <= seen) return undefined;
    if (last.by === this.cfg.id || last.by === "system") return undefined;
    if (last.text === tt("server.task.stoppedByBoss", "Stopped by the boss; back to todo.").trim()) return undefined;
    return last.text;
  }

  private noteTaskTalk() {
    if (this.taskId !== undefined && this.taskTalkFor !== this.taskId) { this.taskTalk = []; this.taskTalkFor = this.taskId; }
  }

  // The chat learns how the task went, and everything the boss said inside the task session, word for word.
  private handBack(id: number) {
    const k = this.colleagues?.board().tasks.find((x) => x.id === id);
    let note = t("server.task.backNote", { id, title: k?.title ?? "", status: k?.status ?? "-", note: k?.notes[k.notes.length - 1]?.text.slice(0, 600) ?? "-" });
    if (this.taskTalkFor === id && this.taskTalk.length) {
      note += "\n" + tt("server.task.bossDuringTask", "[While you worked on task #{id} in its work session, this was said there. The boss expects you to remember it:]\n{talk}", { id, talk: this.taskTalk.join("\n\n") });
    }
    this.taskTalk = [];
    this.taskTalkFor = undefined;
    this.addPreamble(note);
  }

  // Back to the chat session once the task is no longer "doing".
  private leaveFinishedTask(): boolean {
    if (this.taskId === undefined || this.busy) return false;
    const k = this.colleagues?.board().tasks.find((x) => x.id === this.taskId);
    if (k && k.status === "doing" && k.owner === this.cfg.id) return false;
    const id = this.taskId;
    this.taskId = undefined;
    this.handBack(id);
    this.stopQuery();
    return true;
  }

  // The boss stopped the task's turn: the task goes back to "todo" (or, for a meeting, waits in the queue to be resumed).
  private stopTask(mode: "todo" | "requeue") {
    const id = this.taskId;
    if (id === undefined) return;
    this.taskId = undefined;
    this.stopQuery();
    if (mode === "requeue") {
      if (!this.taskQueue.some((q) => q.id === id)) this.taskQueue.unshift({ id });
      return;
    }
    this.taskQueue = this.taskQueue.filter((q) => q.id !== id);
    const board = this.colleagues?.board();
    const k = board?.tasks.find((x) => x.id === id);
    if (board && k && k.status === "doing") {
      board.markTask(id, { autoStart: null }); // stopped means stopped: it does not begin again by itself
      board.updateTask(id, { status: "todo", note: tt("server.task.stoppedByBoss", "Stopped by the boss; back to todo.") }, "user");
    }
    this.handBack(id);
  }

  // Something changed while this employee sat idle (a task was closed from the panel, the meeting ended, they recovered).
  poke() {
    if (this.busy || this.sick || this.inMeeting) return;
    this.leaveFinishedTask();
    this.afterTurn();
  }

  // The turn is over: what waited goes out now, the boss first.
  private afterTurn() {
    if (this.disposed || this.inMeeting || this.busy || this.sick) return;
    if (this.side) { this.side = undefined; this.stopQuery(true); }
    this.leaveFinishedTask();
    if (this.bossQueue.length) {
      const route = this.routeFor("boss");
      if (route !== "hold" && this.deliverBoss(route)) return;
    }
    while (this.taskId === undefined && this.taskQueue.length) {
      const next = this.taskQueue.shift()!;
      if (this.beginTask(next.id, next.from)) return;
    }
    if (this.taskId === undefined && this.autoQueue.length) {
      const due = this.autoQueue.splice(0).filter((m) => !m.still || m.still());
      if (due.length) { this.send(due.map((m) => m.text).join("\n\n"), true); return; }
    }
    this.deliverHeld();
  }

  // A message from the office itself. Never dropped into a running turn: it waits until this employee is free.
  // `still` is asked again at the moment of delivery: a call that was overtaken by events is dropped instead of costing a turn.
  sendWhenFree(text: string, still?: () => boolean) {
    if (!this.autoQueue.some((m) => m.text === text)) this.autoQueue.push({ text, still }); // the same call twice is one call
    if (!this.busy && !this.sick && !this.inMeeting && this.taskId === undefined && !this.side) this.afterTurn();
  }

  // Board news for the project manager. It rides along with the next message; `wake` starts a turn for it when the manager is free.
  addDigest(line: string) {
    this.digest.push(line);
    if (this.digest.length > 40) this.digest.splice(0, this.digest.length - 40);
  }

  // Self-refresh in a throw-away session: tidying the memory file does not need the whole chat behind it.
  refresh(): boolean {
    if (this.busy || this.sick || this.inMeeting || this.taskId !== undefined || this.side || this.bossQueue.length) return false;
    this.refreshPrev = this.store.getMeta<number>(this.cfg.id, "lastRefresh") ?? 0;
    this.side = "refresh";
    const prompt = t("server.refreshPrompt");
    this.push({ role: "auto", text: prompt, ts: Date.now() });
    const mine = this.colleagues?.board().tasks.filter((k) => k.owner === this.cfg.id && k.notes.length).slice(-8)
      .map((k) => `- #${k.id} ${k.title} [${k.status}]: ${k.notes[k.notes.length - 1].text.replace(/\s+/g, " ").slice(0, 300)}`) ?? [];
    const chat = this.history.filter((m) => m.role === "user" || m.role === "assistant").slice(-12)
      .map((m) => `- ${m.role === "user" ? t("server.meeting.boss") : this.cfg.name}: ${m.text.replace(/\s+/g, " ").slice(0, 300)}`);
    this.dispatch("side", prompt + "\n\n" + t("server.refreshRecent", { tasks: mine.join("\n") || "-", chat: chat.join("\n") || "-" }));
    return true;
  }

  // The boss wrote during a refresh: the refresh is dropped (it runs again at a quieter moment) and the boss is answered in the chat.
  private abandonSide() {
    if (!this.side) return;
    this.side = undefined;
    this.stopQuery(true);
    this.rejectPending(t("server.cancelled"));
    this.unanswered = [];
    this.turnTexts = [];
    this.streamText = "";
    this.emit("chunk_end");
    this.closeTurn("");
    this.store.setMeta(this.cfg.id, "lastRefresh", this.refreshPrev ?? 0);
    this.push({ role: "activity", text: tt("server.refreshCancelled", "Knowledge refresh cancelled because the boss wrote; it will run again at a quieter moment."), ts: Date.now() });
    this.setStatus("idle");
  }

  get sick() { return this.status === "sick"; }
  get inMeetingTurn() { return this.meetingTurn; }

  private addPreamble(note: string) {
    this.preamble = this.preamble ? this.preamble + "\n" + note : note;
  }

  // Notes for the chat session, taken with the next chat message.
  private takePreamble(): string {
    const parts = [
      this.recapNext ? this.chatRecap(this.recapNext) : "",
      this.preamble,
      this.digest.length ? t("server.board.digest", { list: this.digest.map((x) => "- " + x).join("\n") }) : "",
    ].filter(Boolean);
    this.recapNext = undefined;
    this.preamble = "";
    this.digest = [];
    return parts.length ? parts.join("\n\n") + "\n\n" : "";
  }

  // A new chat session knows nothing of the chat the boss sees: a short recap goes with its first message.
  private chatRecap(why: string): string {
    const who = (m: ChatMessage) => (m.role === "user" ? t("server.meeting.boss") : m.role === "colleague" ? m.from ?? "?" : this.cfg.name);
    const chat = this.history.filter((m) => (m.role === "user" || m.role === "assistant" || m.role === "colleague") && !m.queued).slice(-20)
      .map((m) => `- ${who(m)}: ${clip(m.text.replace(/\s+/g, " "), 400)}`);
    const tasks = this.colleagues?.board().tasks.filter((k) => k.owner === this.cfg.id && k.status !== "done").slice(-10)
      .map((k) => `- #${k.id} ${k.title} [${k.status}]`) ?? [];
    return tt("server.recap", "[Note: this is a new work session; the previous one could not be continued ({why}). This is what came before, so you can go on without asking the boss again.\nRecent lines of the chat:\n{chat}\nYour open board tasks:\n{tasks}]",
      { why, chat: chat.join("\n") || "-", tasks: tasks.join("\n") || "-" });
  }

  private taskRecap(id: number): string {
    const k = this.colleagues?.board().tasks.find((x) => x.id === id);
    const notes = k?.notes.slice(-6).map((n) => `- ${clip(n.text.replace(/\s+/g, " "), 500)}`) ?? [];
    return tt("server.taskRecap", "[Note: the earlier work session of this task could not be continued, so this one starts fresh. Notes on the task so far:\n{notes}]", { notes: notes.join("\n") || "-" });
  }

  // One turn of a meeting: the prompt and the answer stay out of this employee's own chat; resolves with what they said.
  // A chat turn that is still running finishes first, so its reply is not taken for the meeting answer (and the other way round).
  async sendMeeting(prompt: string, images?: ImageInput[]): Promise<string> {
    await this.whenFree(10 * 60e3);
    if (!this.inMeeting || this.routeFor("meeting") === "hold") return ""; // the meeting ended meanwhile, or the employee never got free
    this.meetingTurn = true;
    this.turnTexts = [];
    const reply = new Promise<string>((resolve) => {
      let open = true;
      const done = (text: string) => { if (!open) return; open = false; clearTimeout(timer); clearTimeout(backstop); this.off("turn", done); this.meetingTurn = false; resolve(text ?? ""); };
      let backstop: NodeJS.Timeout | undefined;
      // a turn that runs too long is stopped: its late answer must not land in the chat
      const timer = setTimeout(() => {
        if (this.meetingTurn && this.busy) { void this.interrupt({ task: "keep", resume: false }); backstop = setTimeout(() => done(""), 10e3); }
        else done("");
      }, 5 * 60e3);
      this.on("turn", done);
    });
    this.dispatch("chat", prompt, { images });
    return reply;
  }

  private whenFree(maxMs: number): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); this.off("status", on); resolve(); };
      const on = () => { if (!this.busy) finish(); };
      const timer = setTimeout(finish, maxMs);
      this.on("status", on);
    });
  }

  raiseHand(reason: string) {
    this.emit("raise_hand", reason);
  }

  // After a meeting: a card in the chat, and the model learns it is over with the next message.
  meetingOver(topic: string, summary?: string) {
    this.push({ role: "meeting", text: summary ? t("server.meeting.chatSummary", { topic, summary }) : t("server.meeting.chatEnded", { topic }), ts: Date.now() });
    this.addPreamble(t("server.meeting.overNote", { topic }));
  }

  // Falls ill for `ms`: messages are still accepted but wait until recovery.
  fallIll(ms: number) {
    if (this.status !== "idle" || this.pending.size || this.inMeeting) return;
    this.sickUntil = Date.now() + ms;
    this.push({ role: "system", text: t("server.sick", { name: this.cfg.name }), ts: Date.now() });
    this.setStatus("sick");
    clearTimeout(this.sickTimer);
    this.sickTimer = setTimeout(() => this.recover(), ms);
  }

  recover() {
    if (!this.sick) return;
    clearTimeout(this.sickTimer);
    this.sickTimer = undefined;
    this.sickUntil = 0;
    this.push({ role: "system", text: t("server.recovered", { name: this.cfg.name }), ts: Date.now() });
    if (this.inbox.length) {
      this.setStatus("working");
      this.turnOpen = true;
      if (this.q) { this.wake?.(); this.wake = undefined; } else if (!this.cx) this.start(this.runningFor ?? "chat");
    } else { this.setStatus("idle"); this.poke(); }
  }

  // Stop. The running turn ends; a board task it was working on goes back to "todo" (task: "todo"), waits to be resumed
  // (task: "requeue", used by meetings) or stays as it is (task: "keep", used on shutdown). Nothing waiting is thrown away:
  // with `resume` the queued boss messages go out right after, then tasks, office and colleague messages.
  // A second call while one is running (Stop pressed twice, a shutdown during a stop) joins the first one instead of stopping
  // twice; `resume: false` from any caller wins.
  interrupt(opts: { task?: "todo" | "requeue" | "keep"; resume?: boolean } = {}): Promise<void> {
    if (this.interruptJob) {
      if (opts.resume === false) this.interruptJob.resume = false;
      return this.interruptJob.done;
    }
    if (this.status !== "working" && this.status !== "waiting") return Promise.resolve();
    const job: { resume: boolean; done: Promise<void> } = { resume: opts.resume !== false, done: Promise.resolve() };
    this.interruptJob = job;
    job.done = this.doInterrupt(opts.task ?? "todo", job).finally(() => { if (this.interruptJob === job) this.interruptJob = undefined; });
    return job.done;
  }

  private async doInterrupt(task: "todo" | "requeue" | "keep", job: { resume: boolean }) {
    const key = this.runningFor;
    this.rejectPending(t("server.stoppedByUser"), true);
    this.interrupting = true;
    const ended = this.turnOpen ? new Promise<void>((r) => this.turnEndWaiters.push(r)) : undefined;
    if (this.cx) { this.carry.push(...this.inbox.splice(0)); this.cx.kill(); }
    try { await this.q?.interrupt(); } catch {}
    const endedInTime = ended ? await Promise.race([ended.then(() => true), sleep(5000).then(() => false)]) : true;
    // no result within 5 s: the process may still deliver that turn's late result, which the next turn would take for its own
    // end. It is closed instead of reused (whatever it had not taken yet moves to the next process).
    if (!endedInTime) this.stopQuery();
    this.interrupting = false;
    this.flushStream();
    if (this.turnOpen) this.closeTurn(this.turnTexts.join("\n\n")); // nothing came back: close the turn by hand
    this.unanswered = [];
    this.push({ role: "system", text: t("server.stopped"), ts: Date.now() });
    if (this.side) { this.side = undefined; this.stopQuery(true); }
    if (task !== "keep" && this.taskId !== undefined && key === `task:${this.taskId}`) this.stopTask(task);
    if (!this.disposed) this.applyPending();
    this.setStatus("idle", "interrupted");
    // not in this tick: on shutdown the process exits right after the interrupts, before anything new could start
    if (job.resume) setTimeout(() => this.afterTurn(), 0);
  }

  // "Interrupt" on a queued message: the running turn stops and the queue goes out at once, to the same session
  // (a board task keeps running and gets the message). Without a running turn the queue simply goes out.
  // In a meeting it does nothing (false): the running turn is the meeting answer, and the queue waits for the meeting to end anyway.
  async deliverNow(): Promise<boolean> {
    if (this.inMeeting) return false;
    if (this.busy) await this.interrupt({ task: "keep" });
    else this.poke();
    return true;
  }

  async reset() {
    if (this.sick) { clearTimeout(this.sickTimer); this.sickUntil = 0; }
    await this.interrupt({ resume: false });
    this.stopQuery(true);
    this.carry = [];
    this.sessionId = undefined;
    this.cost = this.context = 0;
    this.store.setMeta(this.cfg.id, "cost", 0);
    this.history = [];
    this.unanswered = [];
    this.taskId = undefined;
    this.taskQueue = [];
    this.taskTalk = [];
    this.taskTalkFor = undefined;
    this.autoQueue = [];
    this.digest = [];
    this.preamble = "";
    this.recapNext = undefined;
    this.bossQueue = [];
    this.emitQueue();
    for (const h of this.held.splice(0)) h.resolve?.("");
    this.store.setSession(this.cfg.id, undefined);
    this.store.saveHistory(this.cfg.id, this.history);
    this.emit("reset");
    this.setStatus("idle");
  }

  // Applies a new config. Nothing running is interrupted for it: the process is replaced at the next turn boundary, so the next
  // message starts with the new options (model, effort, prompt, skills, folder) while resuming the same conversation.
  // Colour, look and the refresh timer need no new process at all.
  async applyConfig(cfg: EmployeeConfig) {
    const prev = this.cfg;
    const cosmetic = cfg !== prev && sameExcept(prev, cfg, ["color", "look", "autoRefresh", "refreshHours"]);
    if (engineOf(cfg.model) !== engineOf(prev.model)) this.pendingEngineSwitch = true;
    this.cfg = cfg;
    if (!cosmetic) this.pendingRestart = true;
    if (!this.busy) this.applyPending();
    this.emit("config");
  }

  // Same as applyConfig, for callers that cannot wait (e.g. the connector switches).
  setConfigQuietly(cfg: EmployeeConfig) {
    void this.applyConfig(cfg);
  }

  // At a turn boundary: settings that waited take effect.
  private applyPending() {
    if (this.pendingEngineSwitch) {
      // another engine cannot continue this one's conversation: the chat starts afresh with a recap; memory and notebook carry over
      this.pendingEngineSwitch = false;
      this.pendingRestart = true;
      if (this.sessionId) {
        this.sessionId = undefined;
        this.store.setSession(this.cfg.id, undefined);
        this.recapNext = tt("server.recapWhy.engine", "the engine was changed");
        this.push({ role: "system", text: tt("server.engineSwitched", "Engine changed: the next message starts a new session and carries a summary of this chat."), ts: Date.now() });
      }
      this.context = 0;
    }
    if (!this.pendingRestart) return;
    this.pendingRestart = false;
    if (this.running) this.stopQuery();
  }

  async dispose() {
    this.disposed = true;
    await this.interrupt({ task: "keep", resume: false });
    this.stopQuery(true);
  }

  reply(requestId: string, decision: ReplyDecision) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (!decision.allow) {
      p.resolve({ behavior: "deny", message: t("server.userDenied") });
      this.push({ role: "activity", text: t("server.denied", { title: p.request.title }), ts: Date.now() });
    } else if (p.request.kind === "question") {
      p.resolve({ behavior: "allow", updatedInput: { ...p.request.input, answers: decision.answers ?? {} } });
      const summary = Object.entries(decision.answers ?? {})
        .map(([q, a]) => `${q} → ${Array.isArray(a) ? a.join(", ") : a}`)
        .join("\n");
      this.push({ role: "user", text: summary || t("server.answered"), ts: Date.now() });
    } else {
      const always = decision.always && p.suggestions?.length ? p.suggestions : undefined;
      p.resolve({ behavior: "allow", updatedInput: p.request.input, updatedPermissions: always });
      this.push({
        role: "activity",
        text: t(always ? "server.alwaysAllowed" : "server.allowed", { title: p.request.title }),
        ts: Date.now(),
      });
    }
    this.emit("ask_done", requestId);
    if (this.pending.size === 0 && this.turnOpen) this.setStatus("working");
  }

  private enqueue(msg: SDKUserMessage) {
    this.inbox.push(msg);
    this.wake?.();
    this.wake = undefined;
  }

  private rejectPending(message: string, interrupt = false) {
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: "deny", message, interrupt });
      this.pending.delete(id);
      this.emit("ask_done", id);
    }
  }

  // Closes the running process. What it had not taken yet is carried over to the next process, unless `discard`.
  private stopQuery(discard = false) {
    if (!discard && this.inbox.length) this.carry.push(...this.inbox);
    if (discard) this.carry = [];
    this.inbox = [];
    this.generation++;
    this.wake?.();
    this.wake = undefined;
    const q = this.q;
    this.q = undefined;
    try { q?.close(); } catch {}
    this.cx?.kill();
    this.cx = undefined;
    this.runningFor = undefined;
    if (this.compacting) { this.compacting = false; this.emit("compacting", false); }
  }

  private async *input(gen: number): AsyncIterable<SDKUserMessage> {
    while (this.generation === gen) {
      const next = this.sick ? undefined : this.inbox.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  private buildPrompt(): string {
    const parts = [this.cfg.systemPrompt];
    const others = this.colleagues?.list().filter((e) => e !== this) ?? [];
    if (others.length) parts.push(t("server.office.prompt", { list: others.map((e) => `- ${e.cfg.name} — ${e.cfg.role}${e.cfg.manager ? " — " + t("server.board.managerTag") : ""}`).join("\n") }));
    if (this.colleagues) parts.push(t(this.cfg.manager ? "server.board.promptManager" : "server.board.prompt"));
    if (this.cfg.worktree && this.cfg.baseCwd && this.cfg.baseCwd !== this.cfg.cwd) parts.push(t("server.worktree.prompt", { branch: `po/${this.cfg.id}`, base: this.cfg.baseCwd }));
    parts.push(t("server.efficiency"));
    if (this.cfg.memoryFile) {
      // the full path: a relative one (../../../…) stops pointing anywhere the moment the employee cd's into a subfolder
      const rel = this.cfg.memoryFile;
      let memory = "";
      try { memory = fs.readFileSync(this.cfg.memoryFile, "utf8").trim(); } catch {}
      parts.push(t("server.memoryPrompt", { file: rel }) + "\n\n" + (memory ? t("server.memoryCurrent", { memory }) : t("server.memoryEmpty")) + (memory.length > MEMORY_SOFT_LIMIT ? "\n\n" + t("server.memoryTooLong", { chars: memory.length, limit: MEMORY_SOFT_LIMIT }) : ""));
    }
    return parts.join("\n\n");
  }

  // Starts a process for one session (`key`): "chat", "task:<id>" or "side".
  private start(key: string) {
    this.runningFor = key;
    if (this.carry.length) this.inbox.unshift(...this.carry.splice(0));
    const gen = this.generation;
    if (this.engine === "codex") { void this.runCodex(gen, key); return; }
    if (this.engine === "gemini") { void this.runGemini(gen, key); return; }
    // OpenRouter runs through Claude Code too, pointed at OpenRouter: same tools, permissions and sessions
    const viaOpenRouter = this.engine === "openrouter";
    this.context = 0;
    const compactAt = getSettings().compactAtTokens;
    const taskId = taskOf(key);
    const task = taskId !== undefined ? this.colleagues?.board().tasks.find((x) => x.id === taskId) : undefined;
    const resumeId = key === "side" ? undefined : taskId !== undefined ? task?.session : this.sessionId;
    this.procPrev = resumeId ? this.sessionTotals()[resumeId] ?? 0 : 0;
    this.procFirst = true;
    this.q = query({
      prompt: this.input(gen),
      options: {
        cwd: this.cfg.cwd,
        // the employee's own folder (memory, skills) lives outside the project they work in: writing there must not be "outside the working directory"
        additionalDirectories: this.cfg.dir ? [this.cfg.dir] : undefined,
        systemPrompt: { type: "preset", preset: "claude_code", append: this.buildPrompt() },
        plugins: this.cfg.pluginDir ? [{ type: "local", path: this.cfg.pluginDir }] : undefined,
        resume: resumeId,
        persistSession: key === "side" ? false : undefined,
        // summarize in place long before the model's own limit: on a 1M-token model a chat otherwise grows until every step re-reads a book
        // one memory, the one the boss sees on the profile page: Claude Code's own hidden per-folder memory would be a second place to look
        settings: { autoMemoryEnabled: false, ...(compactAt ? { autoCompactWindow: compactAt } : {}), ...(this.cfg.connectorsOff?.length ? { deniedMcpServers: this.cfg.connectorsOff.map((serverName) => ({ serverName })) } : {}) },
        env: compactAt || viaOpenRouter ? { ...process.env, ...(compactAt ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compactAt) } : {}), ...(viaOpenRouter ? openrouterEnv(this.cfg.model!) : {}) } : undefined,
        // compaction summarizes everything, the newest boss message included: it is handed back word for word right after the summary
        hooks: { SessionStart: [{ matcher: "compact", hooks: [async () => this.afterCompact()] }] },
        title: taskId !== undefined ? `${this.cfg.name} — #${taskId} ${task?.title ?? ""}`.slice(0, 120) : `${this.cfg.name} — ${this.cfg.role}`,
        includePartialMessages: true,
        permissionMode: this.cfg.permissionMode ?? "default",
        allowedTools: [...(this.cfg.allowedTools ?? []), ...OFFICE_TOOLS],
        mcpServers: this.colleagues ? { office: officeServer(this, this.colleagues) } : undefined,
        model: viaOpenRouter ? openrouterSlug(this.cfg.model!) : this.cfg.model,
        // effort is a Claude setting; other models behind OpenRouter may reject it
        effort: viaOpenRouter ? undefined : this.cfg.effort,
        settingSources: this.cfg.settingSources ?? ["project"],
        canUseTool: (toolName, input, opts) => this.canUseTool(toolName, input, opts),
      },
    });
    this.consume(gen, key);
  }

  private afterCompact(): HookJSONOutput {
    const open = this.unanswered.map(plainText).map((s) => s.trim()).filter(Boolean);
    if (!open.length) return { continue: true };
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: tt("server.compactReinject", "[pixel-office: the conversation was just summarized. These are the messages you have not answered yet, word for word. They are the current request: answer them first and do not go back to older work unless they ask for it.]\n\n{messages}",
          { messages: open.map((s) => clip(s, 6000)).join("\n\n---\n\n") }),
      },
    };
  }

  private async consume(gen: number, key: string) {
    try {
      for await (const m of this.q!) {
        if (this.generation !== gen) break;
        this.handle(m, key);
      }
    } catch (err) {
      if (this.generation !== gen) return;
      this.flushStream();
      this.rejectPending(t("server.sessionError"));
      this.push({ role: "system", text: t("server.error", { message: (err as Error).message }), ts: Date.now() });
      this.closeTurn(this.turnTexts.join("\n\n"));
      this.setStatus("error");
      setTimeout(() => this.afterTurn(), 0); // what waited for this turn is not stuck behind the error
    } finally {
      if (this.generation === gen) {
        this.q = undefined;
        this.runningFor = undefined;
        if (this.turnOpen) this.closeTurn(this.turnTexts.join("\n\n"));
        if (this.status === "working" || this.status === "waiting") { this.setStatus("idle"); setTimeout(() => this.afterTurn(), 0); }
      }
    }
  }

  private handle(m: SDKMessage, key: string) {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          this.model = m.model;
          const taskId = taskOf(key);
          if (taskId !== undefined) this.colleagues?.board().markTask(taskId, { session: m.session_id });
          else if (key === "chat") { this.sessionId = m.session_id; this.store.setSession(this.cfg.id, m.session_id); }
          console.log(t("server.sessionOpened", { name: this.cfg.name, model: m.model }));
        } else if (m.subtype === "compact_boundary") {
          this.push({ role: "activity", text: t("server.compacted", { tokens: Math.round(m.compact_metadata.pre_tokens / 1000) }), ts: Date.now() });
        } else if (m.subtype === "status") {
          const on = m.status === "compacting";
          if (on !== this.compacting) { this.compacting = on; this.emit("compacting", on); }
        }
        break;
      case "stream_event": {
        if (m.parent_tool_use_id) break;
        const ev = m.event as { type: string; delta?: { type: string; text?: string } };
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          this.streamText += ev.delta.text;
          if (!this.meetingTurn) this.emit("chunk", ev.delta.text);
        }
        break;
      }
      case "assistant": {
        if (m.parent_tool_use_id) break;
        const u = m.message.usage;
        if (u) this.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        for (const block of m.message.content) {
          if (block.type === "text") {
            this.streamText = "";
            this.emit("chunk_end");
            if (block.text.trim()) this.push({ role: "assistant", text: block.text, ts: Date.now() });
          } else if (block.type === "tool_use") {
            this.push({ role: "activity", text: describeTool(block.name, block.input as Record<string, unknown>), ts: Date.now() });
          }
        }
        break;
      }
      case "rate_limit_event":
        if (this.engine !== "claude") break; // OpenRouter's limits are not the Claude plan's
        fromClaudeRateLimit(m.rate_limit_info as unknown as Record<string, unknown>);
        break;
      case "result": {
        const total = Number(m.total_cost_usd) || 0;
        if (this.procFirst && total < this.procPrev) this.procPrev = 0; // this transcript did not carry its earlier total
        this.procFirst = false;
        const delta = Math.max(0, total - this.procPrev);
        if (delta > 0) {
          this.procPrev = total;
          if (key !== "side" && m.session_id) this.rememberSessionTotal(m.session_id, total);
          this.cost += delta;
          this.store.setMeta(this.cfg.id, "cost", this.cost);
        }
        this.turnSpend = { cost: delta };
        // the plan's windows, when the CLI can tell (a plain HTTP call, no tokens), now and then
        if (this.engine === "claude" && claudeUsageDue()) this.q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.({ skipBehaviors: true }).then(fromClaudeUsage, () => {});
        const detail = m.subtype === "success" ? undefined : "errors" in m && Array.isArray(m.errors) ? m.errors.join("; ") : m.subtype;
        // more turns queued inside the CLI follow without further input: the employee is not free yet
        const more = (m.queued_turn_count ?? 0) > 0 && !this.interrupting;
        this.endTurn(detail, m.duration_ms, !!detail && /No conversation found/i.test(detail), more);
        break;
      }
    }
  }

  // Emits the turn's text for whoever waits on it (meetings, colleagues) and releases interrupt().
  private closeTurn(text: string) {
    this.turnTexts = [];
    this.turnOpen = false;
    this.turnIdea = undefined; // edit_idea is for the turn the idea was asked in, not for whatever comes next
    this.emit("turn", text);
    for (const w of this.turnEndWaiters.splice(0)) w();
  }

  // The end of a turn, whichever engine ran it. `detail` = what went wrong, if anything; `more` = another turn follows at once.
  private endTurn(detail: string | undefined, durationMs: number, sessionLost = false, more = false) {
    this.flushStream();
    const key = this.runningFor;
    this.emitSpend(key);
    const wasInterrupted = this.interrupting;
    if (more) {
      if (detail && !wasInterrupted) this.push({ role: "system", text: t("server.turnError", { detail }), ts: Date.now() });
      return;
    }
    this.interrupting = false;
    if (detail && !wasInterrupted && sessionLost && key !== "side" && !this.recovered && (taskOf(key) !== undefined || this.sessionId)) {
      this.turnTexts = [];
      this.recoverSession(key!);
      return;
    }
    const turn = this.turnTexts.join("\n\n");
    if (taskOf(key) !== undefined && this.taskTurnHasBoss) {
      this.taskTurnHasBoss = false;
      if (turn.trim()) this.taskTalk.push(`${tt("server.task.talkYou", "You")}: ${clip(turn, 1500)}`);
    }
    // the chat session learns what the refresh changed, instead of hearing nothing of it
    if (key === "side" && !detail && turn.trim()) this.addPreamble(tt("server.refreshNote", "[Note: in a separate short session you tidied your memory file. What you reported: {summary}]", { summary: clip(turn.replace(/\s+/g, " "), 800) }));
    this.closeTurn(turn);
    this.unanswered = []; // answered, or failed in plain sight: either way not something to replay later
    if (!detail) this.recovered = false;
    else if (!wasInterrupted) this.push({ role: "system", text: t("server.turnError", { detail }), ts: Date.now() });
    if (wasInterrupted) return; // interrupt() does the rest
    this.emit("result", { cost: this.cost, durationMs, context: this.context });
    this.applyPending();
    if (this.pending.size === 0) this.settle();
  }

  // The ledger hears of every finished turn that spent something, whatever happens to the turn afterwards.
  private emitSpend(key?: string) {
    const s = this.turnSpend;
    this.turnSpend = undefined;
    if (!s || (s.cost <= 0 && !s.tokens)) return;
    const task = taskOf(key);
    const kind: CostKind = this.meetingTurn ? "meeting" : key === "side" ? "refresh"
      : task !== undefined ? (this.colleagues?.board().tasks.find((x) => x.id === task)?.kind === "discovery" ? "discovery" : "task") : "chat";
    const spend: Spend = { cost: s.cost, kind, ...(task !== undefined ? { task } : {}), model: this.model ?? this.cfg.model ?? "", engine: this.engine, ...(s.tokens ? { tokens: s.tokens } : {}) };
    this.emit("spend", spend);
  }

  // Last running total per session / thread, kept across restarts so a resumed session is not counted twice.
  private sessionTotals(): Record<string, number> { return this.store.getMeta<Record<string, number>>(this.cfg.id, "sessionCost") ?? {}; }
  private rememberSessionTotal(session: string, total: number) {
    const all = { ...this.sessionTotals(), [session]: total };
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete all[k];
    this.store.setMeta(this.cfg.id, "sessionCost", all);
  }

  // Idle, unless something that waited starts right away: then the employee never shows as free in between
  // (a meeting, the refresh timer or a task start would otherwise take that moment).
  private settle() {
    this.status = "idle"; // not announced yet
    this.afterTurn();
    if (this.status === "idle") this.setStatus("idle");
  }

  // ---- Codex engine: a process per turn, the conversation kept by thread id ----
  private async runCodex(gen: number, key: string) {
    this.cx = { kill: () => {} };
    let failed = false;
    try {
      while (this.generation === gen && !this.sick && this.engine === "codex") {
        const batch = this.inbox.splice(0); // what piled up is one turn, as it would be for a person
        if (!batch.length) break;
        const files = batch.flatMap((m) => this.plain.get(m)?.files ?? []);
        const prompt = batch.map(plainText).filter(Boolean).join("\n\n");
        const taskId = taskOf(key);
        const task = taskId !== undefined ? this.colleagues?.board().tasks.find((x) => x.id === taskId) : undefined;
        const thread = key === "side" ? undefined : taskId !== undefined ? task?.session : this.sessionId;
        const mode = this.cfg.permissionMode ?? "default";
        const started = Date.now();
        const run = runCodexTurn({
          cwd: this.cfg.cwd, prompt: prompt || "-", model: this.cfg.model!, effort: this.cfg.effort, thread, persist: key !== "side", images: files,
          instructions: this.buildPrompt() + this.codexExtras(),
          sandbox: this.meetingTurn || mode === "plan" ? "read-only" : mode === "bypassPermissions" ? "full" : "workspace-write",
          writableDirs: this.cfg.dir ? [this.cfg.dir] : [],
          mcpUrl: this.colleagues?.mcpUrl(this),
        }, {
          onThread: (id) => {
            if (this.generation !== gen) return;
            this.model = this.cfg.model;
            if (taskId !== undefined) this.colleagues?.board().markTask(taskId, { session: id });
            else if (key === "chat") { this.sessionId = id; this.store.setSession(this.cfg.id, id); }
          },
          onItemStarted: (item) => { if (this.generation === gen && item.type !== "agent_message" && item.type !== "reasoning") { const line = describeCodex(item); if (line) this.push({ role: "activity", text: line, ts: Date.now() }); } },
          onItem: (item) => {
            if (this.generation !== gen) return;
            if (item.type === "agent_message" && item.text.trim()) { this.emit("chunk", item.text); this.emit("chunk_end"); this.push({ role: "assistant", text: item.text, ts: Date.now() }); }
            // an error item does not end the turn (a failed turn ends with turn.failed): a warning line, not "the turn ended with an error"
            else if (item.type === "error") this.push({ role: "activity", text: tt("server.codex.notice", "Codex: {detail}", { detail: item.message }), ts: Date.now() });
          },
        });
        this.cx = { kill: run.kill };
        const res = await run.done;
        if (this.generation !== gen) return;
        if (res.ok) {
          // usage is summed over the thread: the difference is this turn, spread over its model calls
          const tk = (taskId !== undefined ? this.colleagues?.board().tasks.find((x) => x.id === taskId)?.session : this.sessionId) ?? "-";
          const before = this.cxTokens.get(tk) ?? 0;
          this.cxTokens.set(tk, res.inputTokens);
          this.context = Math.round(Math.max(0, res.inputTokens - before) / Math.max(1, res.calls));
          // the same difference for the ledger, kept across restarts (the in-memory one above starts over)
          const seen = this.store.getMeta<Record<string, [number, number, number]>>(this.cfg.id, "threadTokens") ?? {};
          const [pi, po, pc] = key !== "side" && seen[tk] && seen[tk][0] <= res.inputTokens ? seen[tk] : [0, 0, 0];
          const tokens = { input: res.inputTokens - pi, output: Math.max(0, res.outputTokens - po), cached: Math.max(0, res.cachedTokens - pc) };
          const estimate = codexCostOf(this.model ?? this.cfg.model ?? "", tokens);
          this.cost += estimate;
          this.store.setMeta(this.cfg.id, "cost", this.cost);
          this.turnSpend = { cost: estimate, tokens };
          if (key !== "side" && tk !== "-") {
            const next = { ...seen, [tk]: [res.inputTokens, res.outputTokens, res.cachedTokens] as [number, number, number] };
            const keys = Object.keys(next);
            for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete next[k];
            this.store.setMeta(this.cfg.id, "threadTokens", next);
          }
          void fromCodexThread(tk === "-" ? undefined : tk).catch(() => {});
        }
        // messages that came in during the turn run next, in the same session, before the employee counts as free
        const more = res.ok && this.inbox.length > 0 && !this.interrupting;
        this.endTurn(res.ok ? undefined : this.engineError("codex", res.error ?? "codex failed"), Date.now() - started, !!res.notFound, more);
      }
    } catch (err) {
      // e.g. a history save failing (disk full): the employee must not stay "working" with nobody reading its inbox
      failed = true;
      if (this.generation === gen) this.failTurn(err);
    } finally {
      if (this.generation === gen) {
        this.cx = undefined;
        this.runningFor = undefined;
        if (!failed && this.inbox.length && !this.sick) this.start(key);
      }
    }
  }

  // ---- Gemini engine: a process per turn, the conversation kept by session id ----
  private async runGemini(gen: number, key: string) {
    this.cx = { kill: () => {} };
    let failed = false;
    try {
      while (this.generation === gen && !this.sick && this.engine === "gemini") {
        const batch = this.inbox.splice(0); // what piled up is one turn, as it would be for a person
        if (!batch.length) break;
        const files = batch.flatMap((m) => this.plain.get(m)?.files ?? []);
        const text = batch.map(plainText).filter(Boolean).join("\n\n");
        const taskId = taskOf(key);
        const task = taskId !== undefined ? this.colleagues?.board().tasks.find((x) => x.id === taskId) : undefined;
        const session = key === "side" ? undefined : taskId !== undefined ? task?.session : this.sessionId;
        const mode = this.cfg.permissionMode ?? "default";
        // Gemini has no separate place for them: the instructions go in front of the prompt when the session is new or they changed
        const instructions = this.buildPrompt() + this.codexExtras();
        const hash = crypto.createHash("sha1").update(instructions).digest("hex");
        const prompt = (!session || this.gmInstr.get(session) !== hash ? tt("server.gemini.instructions", "<instructions from the office — follow them for this whole conversation>\n{text}\n</instructions>", { text: instructions }) + "\n\n" : "") + (text || "-");
        const apiKey = geminiKey();
        const started = Date.now();
        if (!apiKey) { this.endTurn(tt("server.gemini.noKey", "Gemini has no API key: add one in Settings → Models."), 0); continue; }
        let sid = session;
        let said = "";
        const flush = () => { if (said.trim()) { this.emit("chunk_end"); this.push({ role: "assistant", text: said, ts: Date.now() }); } said = ""; };
        const run = runGeminiTurn({
          cwd: this.cfg.cwd, prompt, model: this.cfg.model!, apiKey, session, images: files,
          // headless Gemini cannot stop and ask: what would need a yes is refused, except in "bypass" (yolo)
          approval: this.meetingTurn || mode === "plan" ? "plan" : mode === "bypassPermissions" ? "yolo" : "auto_edit",
          includeDirs: this.cfg.dir ? [this.cfg.dir] : [],
          mcpUrl: this.colleagues?.mcpUrl(this),
          settingsFile: path.join(os.tmpdir(), "pixel-office", `gemini-${this.cfg.officeId}-${this.cfg.id}.json`),
        }, {
          onSession: (id) => {
            if (this.generation !== gen) return;
            sid = id;
            this.model = this.cfg.model;
            if (taskId !== undefined) this.colleagues?.board().markTask(taskId, { session: id });
            else if (key === "chat") { this.sessionId = id; this.store.setSession(this.cfg.id, id); }
          },
          onText: (chunk) => { if (this.generation !== gen) return; said += chunk; this.emit("chunk", chunk); },
          onTool: (ev) => { if (this.generation !== gen) return; flush(); const line = describeGemini(ev); if (line) this.push({ role: "activity", text: line, ts: Date.now() }); },
          onWarning: (message) => { if (this.generation === gen) this.push({ role: "activity", text: tt("server.gemini.notice", "Gemini: {detail}", { detail: message }), ts: Date.now() }); },
        });
        this.cx = { kill: run.kill };
        const res = await run.done;
        if (this.generation !== gen) return;
        flush();
        if (res.ok) {
          if (sid) this.gmInstr.set(sid, hash);
          this.context = Math.round(res.inputTokens / Math.max(1, res.calls));
          this.turnSpend = { cost: 0, tokens: { input: res.inputTokens, output: res.outputTokens, cached: res.cachedTokens } };
        }
        const more = res.ok && this.inbox.length > 0 && !this.interrupting;
        this.endTurn(res.ok ? undefined : this.engineError("gemini", res.error ?? "gemini failed"), Date.now() - started, !!res.notFound, more);
      }
    } catch (err) {
      failed = true;
      if (this.generation === gen) this.failTurn(err);
    } finally {
      if (this.generation === gen) {
        this.cx = undefined;
        this.runningFor = undefined;
        if (!failed && this.inbox.length && !this.sick) this.start(key);
      }
    }
  }

  // A turn that failed because the sign-in / key is refused: the provider is marked as not connected (Settings → Models says so and
  // offers the sign-in again) and the message says what to do, not just "unauthorized".
  private engineError(engine: "codex" | "gemini", error: string): string {
    if (!AUTH_ERROR.test(error)) return error;
    markAuthFailed(engine);
    return tt(`server.${engine}.authFailed`, engine === "codex" ? "Codex sign-in is no longer valid ({detail}). Sign in again in Settings → Models." : "The Gemini API key was refused ({detail}). Check it in Settings → Models.", { detail: error.slice(0, 120) });
  }

  // A turn loop threw: the turn is closed, the employee shows the error, and what waited is not stuck behind it.
  private failTurn(err: unknown) {
    console.error(`[error] turn of ${this.cfg.id}:`, err instanceof Error ? err.stack ?? err.message : err);
    this.interrupting = false;
    try { this.flushStream(); } catch {}
    this.rejectPending(t("server.sessionError"));
    try { this.push({ role: "system", text: t("server.error", { message: (err as Error)?.message ?? String(err) }), ts: Date.now() }); } catch {}
    this.unanswered = [];
    this.closeTurn(this.turnTexts.join("\n\n"));
    this.setStatus("error");
    setTimeout(() => { try { this.afterTurn(); } catch (e) { console.error(`[error] after the turn of ${this.cfg.id}:`, e); } }, 0);
  }

  // What Claude Code gives an employee by itself and Codex does not: their skills, by file.
  private codexExtras(): string {
    const own = this.cfg.pluginDir ? listSkills(this.cfg.pluginDir).map((s) => ({ ...s, file: skillFile(path.join(this.cfg.pluginDir!, "skills"), s.name) })) : [];
    const project = listProjectSkills(this.cfg.cwd).map((s) => ({ name: s.name, description: s.description, file: path.join(s.dir, "SKILL.md") }));
    const index = skillsIndex([...own, ...project]);
    return index ? "\n\n" + t("server.codex.skills", { list: index }) : "";
  }

  // The session to resume was not found: a new one starts, with a recap in front of the messages it had not answered.
  private recoverSession(key: string) {
    const replay = this.unanswered.slice();
    this.stopQuery(true);
    this.recovered = true;
    const taskId = taskOf(key);
    if (taskId !== undefined) this.colleagues?.board().markTask(taskId, { session: null });
    else { this.sessionId = undefined; this.store.setSession(this.cfg.id, undefined); }
    this.push({ role: "system", text: t("server.sessionRecovered"), ts: Date.now() });
    const recap = taskId !== undefined ? this.taskRecap(taskId) : this.chatRecap(tt("server.recapWhy.lost", "the previous session was not found"));
    if (!replay.length) {
      if (taskId === undefined) this.recapNext = tt("server.recapWhy.lost", "the previous session was not found");
      this.closeTurn("");
      this.setStatus("idle");
      this.afterTurn();
      return;
    }
    const [first, ...rest] = replay;
    const lead = userMsg(recap + "\n\n" + plainText(first), Array.isArray(first.message.content)
      ? first.message.content.flatMap((b) => (b.type === "image" && b.source.type === "base64" ? [{ media_type: b.source.media_type as ImageInput["media_type"], data: b.source.data }] : []))
      : undefined);
    const files = this.plain.get(first);
    if (files) this.plain.set(lead, files);
    this.unanswered = [lead, ...rest];
    for (const msg of this.unanswered) this.enqueue(msg);
    this.start(key);
  }

  private canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    opts: {
      signal: AbortSignal;
      requestId: string;
      suggestions?: PermissionUpdate[];
      title?: string;
      description?: string;
      displayName?: string;
      suppressAlwaysAllowRule?: boolean;
    },
  ): Promise<PermissionResult> {
    // In a meeting people talk; nothing that needs the boss's approval is started from there.
    if (this.meetingTurn) return Promise.resolve({ behavior: "deny", message: t("server.meeting.noTools") });
    const isQuestion = toolName === "AskUserQuestion";
    const request: AskRequest = {
      requestId: opts.requestId,
      kind: isQuestion ? "question" : "permission",
      toolName,
      title: isQuestion ? t("server.askQuestion") : opts.title ?? opts.displayName ?? describeTool(toolName, input),
      description: isQuestion ? undefined : opts.description,
      input,
      canAlwaysAllow: !isQuestion && !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule,
    };
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(opts.requestId, { request, suggestions: opts.suggestions, resolve });
      opts.signal.addEventListener("abort", () => {
        if (this.pending.delete(opts.requestId)) {
          resolve({ behavior: "deny", message: t("server.cancelled") });
          this.emit("ask_done", opts.requestId);
        }
      });
      this.setStatus("waiting");
      this.emit("ask", request);
    });
  }

  private flushStream() {
    if (this.streamText.trim()) this.push({ role: "assistant", text: this.streamText, ts: Date.now() });
    this.streamText = "";
    this.emit("chunk_end");
  }

  private push(msg: ChatMessage) {
    if (this.meetingTurn && (msg.role === "assistant" || msg.role === "activity")) {
      if (msg.role === "assistant") this.turnTexts.push(msg.text);
      return;
    }
    this.history.push(msg);
    if (msg.role === "assistant") this.turnTexts.push(msg.text);
    if (msg.role === "user" || msg.role === "assistant" || msg.role === "colleague") this.lastActivity = msg.ts;
    this.store.saveHistory(this.cfg.id, this.history);
    this.emit("message", msg);
  }

  private setStatus(s: Status, reason?: string) {
    this.status = s;
    if (this.announced === s) return;
    this.announced = s;
    this.emit("status", s, reason);
  }
}

// Two configs differ only in the listed fields.
function sameExcept(a: EmployeeConfig, b: EmployeeConfig, fields: Array<keyof EmployeeConfig>): boolean {
  const skip = new Set<string>(fields);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (skip.has(k)) continue;
    if (JSON.stringify((a as unknown as Record<string, unknown>)[k]) !== JSON.stringify((b as unknown as Record<string, unknown>)[k])) return false;
  }
  return true;
}

function describeCodex(item: CodexItem): string {
  if (item.type === "command_execution") return t("server.tool.Bash", { v: item.command.replace(/^\/bin\/(ba|z)?sh -l?c /, "").replace(/^["']|["']$/g, "").slice(0, 120) });
  if (item.type === "file_change") return (item.changes ?? []).map((c) => t(c.kind === "add" ? "server.tool.Write" : "server.tool.Edit", { v: c.path })).join("\n");
  if (item.type === "web_search") return t("server.tool.WebSearch", { v: item.query ?? "" });
  if (item.type === "mcp_tool_call") return item.server === "office" ? describeTool(`mcp__office__${item.tool}`, item.arguments ?? {}) : `${item.server}: ${item.tool}`;
  return "";
}

function describeGemini(ev: Extract<GeminiEvent, { type: "tool_use" }>): string {
  const p = ev.parameters ?? {};
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const map: Record<string, [string, unknown]> = {
    run_shell_command: ["Bash", p.command], read_file: ["Read", p.file_path ?? p.absolute_path], write_file: ["Write", p.file_path],
    replace: ["Edit", p.file_path], glob: ["Glob", p.pattern], search_file_content: ["Grep", p.pattern], grep_search: ["Grep", p.pattern],
    google_web_search: ["WebSearch", p.query], web_fetch: ["WebFetch", p.prompt],
  };
  const hit = map[ev.tool_name];
  if (hit) return t(`server.tool.${hit[0]}`, { v: s(hit[1]).slice(0, 120) });
  // office tools come back as "office__<tool>" or "mcp_office_<tool>" depending on the CLI version
  const office = ev.tool_name.match(/^(?:mcp_)?office_{1,2}(.+)$/);
  if (office) return describeTool(`mcp__office__${office[1]}`, p);
  return describeTool(ev.tool_name, p);
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
  const arg: Record<string, string> = {
    Read: s(input.file_path), Write: s(input.file_path), Edit: s(input.file_path), Bash: s(input.command).slice(0, 120),
    Glob: s(input.pattern), Grep: s(input.pattern), WebSearch: s(input.query), WebFetch: s(input.url), Agent: s(input.description),
  };
  if (name === "AskUserQuestion") return t("server.askingYou");
  if (name === "mcp__office__message_colleague") return t("server.tool.message_colleague", { v: `${s(input.to)}: ${s(input.message).slice(0, 120)}` });
  if (name === "mcp__office__list_colleagues") return t("server.tool.list_colleagues");
  if (name.startsWith("mcp__office__")) {
    const short = name.slice("mcp__office__".length);
    const v: Record<string, string> = {
      share_note: s(input.title), read_notes: Array.isArray(input.ids) ? `#${(input.ids as unknown[]).join(", #")}` : "", list_tasks: "",
      update_task: `#${s(input.id)}${input.status ? " → " + s(input.status) : ""}`, assign_task: `${s(input.to)}: ${s(input.title)}`, start_task: Array.isArray(input.ids) ? (input.ids as unknown[]).join(", #") : s(input.id),
      colleague_activity: s(input.name), raise_hand: s(input.reason),
      remember: s(input.fact).slice(0, 120), propose_idea: s(input.title), list_ideas: "", review_idea: `#${s(input.id)}${input.rank ? " → " + s(input.rank) : ""}${input.duplicate_of ? " = #" + s(input.duplicate_of) : ""}`, promote_idea: `#${s(input.id)} → ${s(input.to)}`,
    };
    if (short in v) return t(`server.tool.${short}`, { v: v[short] }).trim();
  }
  if (name in arg || name === "TodoWrite") return t(`server.tool.${name}`, { v: arg[name] ?? "" });
  return `${name}${Object.keys(input).length ? ": " + s(input).slice(0, 100) : ""}`;
}
