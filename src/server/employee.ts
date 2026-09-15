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
import { t } from "./runtime.js";
import { officeServer, OFFICE_TOOLS, type Colleagues } from "./office-tools.js";

export type Status = "idle" | "working" | "waiting" | "error";

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
}

export interface ChatMessage {
  role: "user" | "assistant" | "activity" | "system" | "auto" | "colleague";
  text: string;
  ts: number;
  from?: string;
}

export const refreshPrompt = () => t("server.refreshPrompt");

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

const userMsg = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

export class Employee extends EventEmitter {
  status: Status = "idle";
  history: ChatMessage[];
  sessionId?: string;
  cost = 0;
  model?: string;
  lastActivity = 0;

  private q?: Query;
  private inbox: SDKUserMessage[] = [];
  private wake?: () => void;
  private generation = 0;
  private pending = new Map<string, PendingAsk>();
  private streamText = "";
  private unanswered: string[] = [];
  private recovered = false;
  private interrupting = false;
  private colleagues?: Colleagues;
  private turnTexts: string[] = [];

  constructor(public cfg: EmployeeConfig, private store: Store) {
    super();
    this.history = store.loadHistory(cfg.id);
    this.sessionId = store.getSession(cfg.id);
    this.lastActivity = [...this.history].reverse().find((m) => m.role === "user" || m.role === "assistant")?.ts ?? 0;
  }

  get pendingAsks(): AskRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  send(text: string, auto = false) {
    this.push({ role: auto ? "auto" : "user", text, ts: Date.now() });
    this.setStatus("working");
    this.unanswered.push(text);
    this.enqueue(userMsg(text));
    if (!this.q) this.start();
  }

  setColleagues(c: Colleagues) {
    this.colleagues = c;
  }

  // Activity line in this employee's chat (e.g. "forwarded to X").
  note(text: string) {
    this.push({ role: "activity", text, ts: Date.now() });
  }

  // A message from another employee; resolves with this employee's next reply when `wait` is set.
  sendFromColleague(from: Employee, text: string, wait: boolean): Promise<string> {
    this.push({ role: "colleague", text, ts: Date.now(), from: from.cfg.name });
    this.setStatus("working");
    const prompt = t("server.colleagueMsg", { name: from.cfg.name, role: from.cfg.role, text });
    this.unanswered.push(prompt);
    this.enqueue(userMsg(prompt));
    if (!this.q) this.start();
    if (!wait) return Promise.resolve("");
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => { this.off("turn", onTurn); resolve(t("server.office.noReply")); }, 10 * 60e3);
      const onTurn = (reply: string) => { clearTimeout(timer); resolve(reply || t("server.office.noReply")); };
      this.once("turn", onTurn);
    });
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
    this.setStatus("idle", "interrupted");
  }

  async reset() {
    await this.interrupt();
    this.stopQuery();
    this.sessionId = undefined;
    this.cost = 0;
    this.history = [];
    this.unanswered = [];
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
      const next = this.inbox.shift();
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
    if (others.length) parts.push(t("server.office.prompt", { list: others.map((e) => `- ${e.cfg.name} — ${e.cfg.role}`).join("\n") }));
    if (this.cfg.memoryFile) {
      const rel = path.relative(this.cfg.cwd, this.cfg.memoryFile);
      let memory = "";
      try { memory = fs.readFileSync(this.cfg.memoryFile, "utf8").trim(); } catch {}
      parts.push(t("server.memoryPrompt", { file: rel }) + "\n\n" + (memory ? t("server.memoryCurrent", { memory }) : t("server.memoryEmpty")));
    }
    return parts.join("\n\n");
  }

  private start() {
    const gen = this.generation;
    this.q = query({
      prompt: this.input(gen),
      options: {
        cwd: this.cfg.cwd,
        systemPrompt: { type: "preset", preset: "claude_code", append: this.buildPrompt() },
        plugins: this.cfg.pluginDir ? [{ type: "local", path: this.cfg.pluginDir }] : undefined,
        resume: this.sessionId,
        title: `${this.cfg.name} — ${this.cfg.role}`,
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
          this.sessionId = m.session_id;
          this.model = m.model;
          this.store.setSession(this.cfg.id, m.session_id);
          console.log(t("server.sessionOpened", { name: this.cfg.name, model: m.model }));
        }
        break;
      case "stream_event": {
        if (m.parent_tool_use_id) break;
        const ev = m.event as { type: string; delta?: { type: string; text?: string } };
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          this.streamText += ev.delta.text;
          this.emit("chunk", ev.delta.text);
        }
        break;
      }
      case "assistant": {
        if (m.parent_tool_use_id) break;
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
          this.cost = m.total_cost_usd;
          this.recovered = false;
          this.unanswered = [];
        } else if (!wasInterrupted) {
          const detail = "errors" in m && Array.isArray(m.errors) ? m.errors.join("; ") : m.subtype;
          if (/No conversation found/i.test(detail) && this.sessionId && !this.recovered) {
            this.recoverSession();
            return;
          }
          this.push({ role: "system", text: t("server.turnError", { detail }), ts: Date.now() });
        }
        if (wasInterrupted) break;
        this.emit("result", { cost: this.cost, durationMs: m.duration_ms });
        if (this.pending.size === 0) this.setStatus("idle");
        break;
      }
    }
  }

  private recoverSession() {
    const replay = this.unanswered.slice();
    this.stopQuery();
    this.recovered = true;
    this.sessionId = undefined;
    this.store.setSession(this.cfg.id, undefined);
    this.push({ role: "system", text: t("server.sessionRecovered"), ts: Date.now() });
    for (const text of replay) this.enqueue(userMsg(text));
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
  if (name in arg || name === "TodoWrite") return t(`server.tool.${name}`, { v: arg[name] ?? "" });
  return `${name}${Object.keys(input).length ? ": " + s(input).slice(0, 100) : ""}`;
}
