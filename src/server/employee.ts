import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type PermissionResult,
  type PermissionUpdate,
  type PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "./store.js";
import { t, getSettings } from "./runtime.js";
import { officeServer, OFFICE_TOOLS, type Colleagues } from "./office-tools.js";

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
}

export interface ImageInput {
  media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string; // base64
}

export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);


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

// A memory file is paid for in every session; past this size the employee is asked to condense it.
const MEMORY_SOFT_LIMIT = 8000;

export class Employee extends EventEmitter {
  status: Status = "idle";
  history: ChatMessage[];
  sessionId?: string;
  cost = 0;
  context = 0; // tokens in the model's window at its last call: what every further step of this conversation costs to re-read
  model?: string;
  lastActivity = 0;
  sickUntil = 0;
  inMeeting = false;
  private sickTimer?: NodeJS.Timeout;
  private meetingTurn = false;
  private preamble = ""; // told to the model with the next ordinary message (e.g. "the meeting is over")

  private q?: Query;
  private inbox: SDKUserMessage[] = [];
  private wake?: () => void;
  private generation = 0;
  private pending = new Map<string, PendingAsk>();
  private streamText = "";
  private unanswered: SDKUserMessage[] = [];
  private recovered = false;
  private interrupting = false;
  private colleagues?: Colleagues;
  private turnTexts: string[] = [];
  private costBase = 0;    // spent by earlier Claude processes of this employee
  private taskId?: number; // the board task being worked on, in a clean session of its own
  private taskQueue: Array<{ id: number; from?: Employee }> = [];
  private side?: "refresh"; // a throw-away session that leaves no trace in the chat session
  private held: Array<{ from: Employee; text: string; resolve?: (reply: string) => void }> = []; // colleague messages waiting for the running turn to end
  private autoQueue: Array<{ text: string; still?: () => boolean }> = []; // office messages (e.g. "discovery round") that wait for a free moment instead of cutting into a turn
  private digest: string[] = []; // board news for the project manager, handed over with the next message instead of costing a turn each

  constructor(public cfg: EmployeeConfig, private store: Store) {
    super();
    this.history = store.loadHistory(cfg.id);
    this.sessionId = store.getSession(cfg.id);
    this.cost = store.getMeta<number>(cfg.id, "cost") ?? 0;
    this.lastActivity = [...this.history].reverse().find((m) => m.role === "user" || m.role === "assistant")?.ts ?? 0;
  }

  get pendingAsks(): AskRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  get busy() { return this.status === "working" || this.status === "waiting"; }
  get currentTask() { return this.taskId; }
  get hasOfficeMessages() { return this.autoQueue.length > 0; }
  get hasNews() { return this.digest.length > 0; }

  send(text: string, auto = false, images?: ImageInput[]) {
    this.leaveFinishedTask();
    const urls = images?.map((im) => {
      const name = this.store.saveAttachment(this.cfg.id, Buffer.from(im.data, "base64"), im.media_type.split("/")[1].replace("jpeg", "jpg"));
      return `/attachments/${encodeURIComponent(this.cfg.officeId)}/${encodeURIComponent(this.cfg.id)}/${name}`;
    });
    this.push({ role: auto ? "auto" : "user", text, ts: Date.now(), ...(urls?.length ? { images: urls } : {}) });
    if (!this.sick) this.setStatus("working");
    const msg = userMsg(this.takePreamble() + text, images);
    this.unanswered.push(msg);
    this.enqueue(msg);
    if (!this.q && !this.sick) this.start();
  }

  setColleagues(c: Colleagues) {
    this.colleagues = c;
  }

  // Activity line in this employee's chat (e.g. "forwarded to X").
  note(text: string) {
    this.push({ role: "activity", text, ts: Date.now() });
  }

  // A message from another employee; resolves with this employee's next reply when `wait` is set.
  // While a turn is running (or a meeting is on) it waits: a message dropped into the middle of a turn reaches the model
  // inside a tool result, where it looks like an injection and gets ignored. Everything that piled up arrives as one message.
  sendFromColleague(from: Employee, text: string, wait: boolean): Promise<string> {
    this.leaveFinishedTask();
    this.push({ role: "colleague", text, ts: Date.now(), from: from.cfg.name });
    const reply = wait ? new Promise<string>((resolve) => {
      let open = true;
      const once = (r: string) => { if (!open) return; open = false; clearTimeout(timer); resolve(r || t("server.office.noReply")); };
      const timer = setTimeout(() => once(""), 10 * 60e3);
      this.held.push({ from, text, resolve: once });
    }) : (this.held.push({ from, text }), Promise.resolve(""));
    if (!this.busy && !this.inMeeting) this.deliverHeld();
    return reply;
  }

  private deliverHeld(): boolean {
    if (!this.held.length) return false;
    const batch = this.held.splice(0);
    const waiters = batch.filter((h) => h.resolve);
    if (waiters.length) this.once("turn", (reply: string) => { for (const w of waiters) w.resolve!(reply); });
    const body = batch.map((h) => t("server.colleagueMsg", { name: h.from.cfg.name, role: h.from.cfg.role, text: h.text })).join("\n\n");
    if (!this.sick) this.setStatus("working");
    const msg = userMsg(this.takePreamble() + body + "\n\n" + t("server.colleagueRules"));
    this.unanswered.push(msg);
    this.enqueue(msg);
    if (!this.q && !this.sick) this.start();
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
    this.stopQuery();
    this.taskId = id;
    this.setStatus("working"); // before the board hears about it: its listeners must find this employee busy
    const back = k.session ? k.notes[k.notes.length - 1]?.text : undefined; // sent back (e.g. from review): same session, plus what was said
    board.updateTask(id, { status: "doing" }, from?.cfg.id ?? "user");
    this.push({ role: "system", text: t(k.session ? "server.task.resumed" : "server.task.cleanSession", { id }), ts: Date.now() });
    const text = t("server.board.taskMessage", { id, title: k.title, detail: k.detail || "-" })
      + (k.kind === "discovery" ? "\n\n" + t("server.cycle.discoveryTask") : "")
      + (from ? "\n\n" + t("server.task.startedBy", { name: from.cfg.name }) : "")
      + (back ? "\n\n" + t("server.task.backWith", { note: back }) : "");
    this.push({ role: from ? "colleague" : "user", text, ts: Date.now(), ...(from ? { from: from.cfg.name } : {}) });
    this.setStatus("working");
    const msg = userMsg(text);
    this.unanswered.push(msg);
    this.enqueue(msg);
    this.start();
    return true;
  }

  // Back to the chat session once the task is no longer "doing"; the chat learns the outcome in two lines.
  private leaveFinishedTask(): boolean {
    if (this.taskId === undefined || this.busy) return false;
    const k = this.colleagues?.board().tasks.find((x) => x.id === this.taskId);
    if (k && k.status === "doing" && k.owner === this.cfg.id) return false;
    const note = t("server.task.backNote", { id: this.taskId, title: k?.title ?? "", status: k?.status ?? "-", note: k?.notes[k.notes.length - 1]?.text.slice(0, 600) ?? "-" });
    this.preamble = this.preamble ? this.preamble + "\n" + note : note;
    this.taskId = undefined;
    this.stopQuery();
    return true;
  }

  // Something changed while this employee sat idle (a task was closed from the panel, the meeting ended, they recovered).
  poke() {
    if (this.busy || this.sick || this.inMeeting) return;
    this.leaveFinishedTask();
    this.afterTurn();
  }

  private afterTurn() {
    if (this.inMeeting || this.busy) return;
    if (this.side) { this.side = undefined; this.stopQuery(); }
    this.leaveFinishedTask();
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
    if (this.busy || this.sick || this.inMeeting || this.taskId !== undefined || this.side) return false;
    this.stopQuery();
    this.side = "refresh";
    const prompt = t("server.refreshPrompt");
    this.push({ role: "auto", text: prompt, ts: Date.now() });
    this.setStatus("working");
    const mine = this.colleagues?.board().tasks.filter((k) => k.owner === this.cfg.id && k.notes.length).slice(-8)
      .map((k) => `- #${k.id} ${k.title} [${k.status}]: ${k.notes[k.notes.length - 1].text.replace(/\s+/g, " ").slice(0, 300)}`) ?? [];
    const chat = this.history.filter((m) => m.role === "user" || m.role === "assistant").slice(-12)
      .map((m) => `- ${m.role === "user" ? t("server.meeting.boss") : this.cfg.name}: ${m.text.replace(/\s+/g, " ").slice(0, 300)}`);
    const msg = userMsg(prompt + "\n\n" + t("server.refreshRecent", { tasks: mine.join("\n") || "-", chat: chat.join("\n") || "-" }));
    this.unanswered.push(msg);
    this.enqueue(msg);
    this.start();
    return true;
  }

  get sick() { return this.status === "sick"; }
  get inMeetingTurn() { return this.meetingTurn; }

  // Notes for the chat session only: a task or refresh session has no use for them.
  private takePreamble(): string {
    if (this.taskId !== undefined || this.side) return "";
    const parts = [this.preamble, this.digest.length ? t("server.board.digest", { list: this.digest.map((x) => "- " + x).join("\n") }) : ""].filter(Boolean);
    this.preamble = "";
    this.digest = [];
    return parts.length ? parts.join("\n\n") + "\n\n" : "";
  }

  // One turn of a meeting: the prompt and the answer stay out of this employee's own chat; resolves with what they said.
  sendMeeting(prompt: string, images?: ImageInput[]): Promise<string> {
    this.meetingTurn = true;
    this.turnTexts = [];
    this.setStatus("working");
    const msg = userMsg(prompt, images);
    this.unanswered.push(msg);
    this.enqueue(msg);
    if (!this.q) this.start();
    return new Promise<string>((resolve) => {
      const done = (reply: string) => { clearTimeout(timer); this.off("turn", done); this.meetingTurn = false; resolve(reply ?? ""); };
      const timer = setTimeout(() => done(""), 5 * 60e3);
      this.on("turn", done);
    });
  }

  raiseHand(reason: string) {
    this.emit("raise_hand", reason);
  }

  // After a meeting: a card in the chat, and the model learns it is over with the next message.
  meetingOver(topic: string, summary?: string) {
    this.push({ role: "meeting", text: summary ? t("server.meeting.chatSummary", { topic, summary }) : t("server.meeting.chatEnded", { topic }), ts: Date.now() });
    const note = t("server.meeting.overNote", { topic });
    this.preamble = this.preamble ? this.preamble + "\n" + note : note;
  }

  // Falls ill for `ms`: messages are still accepted but wait in the inbox until recovery.
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
      if (this.q) { this.wake?.(); this.wake = undefined; } else this.start();
    } else { this.setStatus("idle"); this.poke(); }
  }

  async interrupt() {
    if (this.status !== "working" && this.status !== "waiting") return;
    this.rejectPending(t("server.stoppedByUser"), true);
    this.interrupting = true;
    try {
      await this.q?.interrupt();
    } catch {}
    this.flushStream();
    this.unanswered = [];
    this.push({ role: "system", text: t("server.stopped"), ts: Date.now() });
    if (this.side) { this.side = undefined; this.stopQuery(); }
    this.setStatus("idle", "interrupted");
  }

  async reset() {
    if (this.sick) { clearTimeout(this.sickTimer); this.sickUntil = 0; }
    await this.interrupt();
    this.stopQuery();
    this.sessionId = undefined;
    this.cost = this.costBase = this.context = 0;
    this.store.setMeta(this.cfg.id, "cost", 0);
    this.history = [];
    this.unanswered = [];
    this.taskId = undefined;
    this.taskQueue = [];
    this.autoQueue = [];
    this.digest = [];
    for (const h of this.held.splice(0)) h.resolve?.("");
    this.store.setSession(this.cfg.id, undefined);
    this.store.saveHistory(this.cfg.id, this.history);
    this.emit("reset");
    this.setStatus("idle");
  }

  // Applies a new config; the running Claude process is closed so the next message starts with the new options
  // (model, effort, prompt, skills) while resuming the same conversation.
  async applyConfig(cfg: EmployeeConfig) {
    await this.interrupt();
    this.cfg = cfg;
    this.stopQuery();
    this.emit("config");
  }

  // A change that can wait for the next Claude process: nothing running is interrupted for it.
  setConfigQuietly(cfg: EmployeeConfig) {
    this.cfg = cfg;
    if (!this.busy) this.stopQuery();
    this.emit("config");
  }

  async dispose() {
    await this.interrupt();
    this.stopQuery();
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
    if (this.pending.size === 0) this.setStatus("working");
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

  private stopQuery() {
    this.generation++;
    this.wake?.();
    this.wake = undefined;
    this.q = undefined;
    this.inbox = [];
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

  private start() {
    const gen = this.generation;
    this.costBase = this.cost; // a new Claude process counts its cost from zero
    this.context = 0;
    const compactAt = getSettings().compactAtTokens;
    const task = this.taskId !== undefined ? this.colleagues?.board().tasks.find((x) => x.id === this.taskId) : undefined;
    this.q = query({
      prompt: this.input(gen),
      options: {
        cwd: this.cfg.cwd,
        // the employee's own folder (memory, skills) lives outside the project they work in: writing there must not be "outside the working directory"
        additionalDirectories: this.cfg.dir ? [this.cfg.dir] : undefined,
        systemPrompt: { type: "preset", preset: "claude_code", append: this.buildPrompt() },
        plugins: this.cfg.pluginDir ? [{ type: "local", path: this.cfg.pluginDir }] : undefined,
        resume: this.side ? undefined : this.taskId !== undefined ? task?.session : this.sessionId,
        persistSession: this.side ? false : undefined,
        // summarize in place long before the model's own limit: on a 1M-token model a chat otherwise grows until every step re-reads a book
        // one memory, the one the boss sees on the profile page: Claude Code's own hidden per-folder memory would be a second place to look
        settings: { autoMemoryEnabled: false, ...(compactAt ? { autoCompactWindow: compactAt } : {}), ...(this.cfg.connectorsOff?.length ? { deniedMcpServers: this.cfg.connectorsOff.map((serverName) => ({ serverName })) } : {}) },
        env: compactAt ? { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compactAt) } : undefined,
        title: this.taskId !== undefined ? `${this.cfg.name} — #${this.taskId} ${task?.title ?? ""}`.slice(0, 120) : `${this.cfg.name} — ${this.cfg.role}`,
        includePartialMessages: true,
        permissionMode: this.cfg.permissionMode ?? "default",
        allowedTools: [...(this.cfg.allowedTools ?? []), ...OFFICE_TOOLS],
        mcpServers: this.colleagues ? { office: officeServer(this, this.colleagues) } : undefined,
        model: this.cfg.model,
        effort: this.cfg.effort,
        settingSources: this.cfg.settingSources ?? ["project"],
        canUseTool: (toolName, input, opts) => this.canUseTool(toolName, input, opts),
      },
    });
    this.consume(gen);
  }

  private async consume(gen: number) {
    try {
      for await (const m of this.q!) {
        if (this.generation !== gen) break;
        this.handle(m);
      }
    } catch (err) {
      if (this.generation !== gen) return;
      this.flushStream();
      this.rejectPending(t("server.sessionError"));
      this.push({ role: "system", text: t("server.error", { message: (err as Error).message }), ts: Date.now() });
      this.setStatus("error");
    } finally {
      if (this.generation === gen) {
        this.q = undefined;
        if (this.status === "working" || this.status === "waiting") this.setStatus("idle");
      }
    }
  }

  private handle(m: SDKMessage) {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          this.model = m.model;
          if (this.taskId !== undefined) this.colleagues?.board().markTask(this.taskId, { session: m.session_id });
          else if (!this.side) { this.sessionId = m.session_id; this.store.setSession(this.cfg.id, m.session_id); }
          console.log(t("server.sessionOpened", { name: this.cfg.name, model: m.model }));
        } else if (m.subtype === "compact_boundary") {
          this.push({ role: "activity", text: t("server.compacted", { tokens: Math.round(m.compact_metadata.pre_tokens / 1000) }), ts: Date.now() });
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
      case "result": {
        this.flushStream();
        const turn = this.turnTexts.join("\n\n");
        this.turnTexts = [];
        this.emit("turn", turn);
        const wasInterrupted = this.interrupting;
        this.interrupting = false;
        if (m.subtype === "success") {
          this.cost = this.costBase + m.total_cost_usd;
          this.store.setMeta(this.cfg.id, "cost", this.cost);
          this.recovered = false;
          this.unanswered = [];
        } else if (!wasInterrupted) {
          const detail = "errors" in m && Array.isArray(m.errors) ? m.errors.join("; ") : m.subtype;
          if (/No conversation found/i.test(detail) && !this.side && (this.taskId !== undefined || this.sessionId) && !this.recovered) {
            this.recoverSession();
            return;
          }
          this.push({ role: "system", text: t("server.turnError", { detail }), ts: Date.now() });
        }
        if (wasInterrupted) break;
        this.emit("result", { cost: this.cost, durationMs: m.duration_ms, context: this.context });
        if (this.pending.size === 0) this.setStatus("idle");
        this.afterTurn();
        break;
      }
    }
  }

  private recoverSession() {
    const replay = this.unanswered.slice();
    this.stopQuery();
    this.recovered = true;
    if (this.taskId !== undefined) this.colleagues?.board().markTask(this.taskId, { session: null });
    else { this.sessionId = undefined; this.store.setSession(this.cfg.id, undefined); }
    this.push({ role: "system", text: t("server.sessionRecovered"), ts: Date.now() });
    for (const msg of replay) this.enqueue(msg);
    if (replay.length) this.start();
    else this.setStatus("idle");
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
    if (this.status === s) return;
    this.status = s;
    this.emit("status", s, reason);
  }
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
