import fs from "node:fs";
import { EventEmitter } from "node:events";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Employee, ImageInput } from "./employee.js";
import type { Store } from "./store.js";
import { t } from "./runtime.js";

export interface MeetingEntry {
  ts: number;
  from: string; // "user", "system" or an employee id
  name?: string;
  kind: "say" | "pass" | "hand" | "floor" | "system";
  text: string;
  to?: string[]; // employee ids when the boss addressed only some people
  images?: string[];
}

export interface MeetingTask { to: string; name: string; task: string }

export interface MeetingState {
  id: string;
  topic: string;
  startedAt: number;
  endedAt?: number;
  participants: Array<{ id: string; name: string; joined: boolean }>;
  hands: Array<{ id: string; reason: string }>;
  transcript: MeetingEntry[];
  summary?: string;
  tasks?: MeetingTask[];
  summarizing?: boolean;
}

const PASS_RE = /^\W*pass\W*$/i;

// One meeting in one office: the boss talks to everybody at once, each employee answers briefly or passes,
// and whoever raised a hand can be given the floor. Employees take part through their own sessions, so they remember it.
export class Meeting extends EventEmitter {
  readonly id = new Date().toISOString().replace(/[:.]/g, "-");
  readonly startedAt = Date.now();
  endedAt?: number;
  transcript: MeetingEntry[] = [];
  summary?: string;
  tasks?: MeetingTask[];
  summarizing = false;
  private joined = new Set<string>();
  private hands = new Map<string, string>();
  private seen = new Map<string, number>(); // per employee: how much of the transcript they have heard
  private briefed = new Set<string>();
  private chain = new Map<string, Promise<void>>();
  private unhook = new Map<string, () => void>();

  constructor(readonly topic: string, readonly people: Employee[], private store: Store, private cwd: string) {
    super();
  }

  get active() { return !this.endedAt; }

  state(): MeetingState {
    return {
      id: this.id, topic: this.topic, startedAt: this.startedAt, endedAt: this.endedAt,
      participants: this.people.map((e) => ({ id: e.cfg.id, name: e.cfg.name, joined: this.joined.has(e.cfg.id) })),
      hands: [...this.hands].map(([id, reason]) => ({ id, reason })),
      transcript: this.transcript, summary: this.summary, tasks: this.tasks, summarizing: this.summarizing,
    };
  }

  // Busy people either finish what they are doing first or are interrupted; everybody joins once idle.
  async start(interruptBusy: boolean) {
    for (const e of this.people) {
      e.inMeeting = true;
      const onHand = (reason: string) => this.raiseHand(e, reason);
      e.on("raise_hand", onHand);
      const onStatus = () => this.tryJoin(e);
      e.on("status", onStatus);
      this.unhook.set(e.cfg.id, () => { e.off("raise_hand", onHand); e.off("status", onStatus); });
      if (e.sick) e.recover();
      if (interruptBusy && (e.status === "working" || e.status === "waiting")) await e.interrupt();
      this.tryJoin(e);
    }
    this.emit("state");
  }

  private tryJoin(e: Employee) {
    if (!this.active || this.joined.has(e.cfg.id) || (e.status !== "idle" && e.status !== "error")) return;
    this.joined.add(e.cfg.id);
    e.note(t("server.meeting.joined", { topic: this.topic || t("server.meeting.untitled") }));
    this.emit("state");
    // anything said before they arrived reaches them with the next thing the boss says
  }

  private add(entry: MeetingEntry) {
    this.transcript.push(entry);
    this.emit("entry", entry);
    this.persist();
  }

  private raiseHand(e: Employee, reason: string) {
    if (!this.active) return;
    this.hands.set(e.cfg.id, reason);
    this.add({ ts: Date.now(), from: e.cfg.id, name: e.cfg.name, kind: "hand", text: reason });
    this.emit("state");
  }

  // The boss speaks: to everybody who has joined, or only to `to`.
  say(text: string, images: ImageInput[] | undefined, imageUrls: string[] | undefined, to?: string[]) {
    if (!this.active) return;
    const targets = this.people.filter((e) => this.joined.has(e.cfg.id) && (!to?.length || to.includes(e.cfg.id)));
    const entry: MeetingEntry = { ts: Date.now(), from: "user", kind: "say", text, ...(to?.length ? { to } : {}), ...(imageUrls?.length ? { images: imageUrls } : {}) };
    this.add(entry);
    const index = this.transcript.length - 1;
    for (const e of targets) this.turn(e, index, (heard) => t("server.meeting.round", { heard, to: to?.length ? t("server.meeting.toYou") : t("server.meeting.toAll"), text: text || t("server.meeting.imageOnly") }), images);
  }

  // Gives the floor to somebody (usually one who raised a hand): they may answer at length.
  grant(id: string) {
    const e = this.people.find((x) => x.cfg.id === id);
    if (!this.active || !e || !this.joined.has(id)) return;
    const reason = this.hands.get(id) ?? "";
    this.hands.delete(id);
    this.add({ ts: Date.now(), from: "user", kind: "floor", text: e.cfg.name, to: [id] });
    this.emit("state");
    this.turn(e, this.transcript.length - 1, (heard) => t("server.meeting.floor", { heard, reason }), undefined, true);
  }

  dismissHand(id: string) {
    if (this.hands.delete(id)) this.emit("state");
  }

  // One employee's turn; turns of the same employee run one after another.
  private turn(e: Employee, upTo: number, prompt: (heard: string) => string, images?: ImageInput[], floor = false) {
    const prev = this.chain.get(e.cfg.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (!this.active) return;
      const from = this.seen.get(e.cfg.id) ?? 0;
      const heard = this.transcript.slice(from, upTo)
        .filter((m) => m.from !== e.cfg.id && (m.kind === "say" || m.kind === "floor") && (!m.to || m.to.includes(e.cfg.id) || m.from !== "user"))
        .filter((m) => m.kind === "say")
        .map((m) => `- ${m.from === "user" ? t("server.meeting.boss") : m.name}: ${m.text}`).join("\n");
      this.seen.set(e.cfg.id, upTo + 1);
      let text = prompt(heard ? t("server.meeting.heard", { list: heard }) + "\n\n" : "");
      if (!this.briefed.has(e.cfg.id)) {
        this.briefed.add(e.cfg.id);
        text = t("server.meeting.intro", { topic: this.topic || t("server.meeting.untitled"), people: this.people.filter((p) => p !== e).map((p) => `${p.cfg.name} (${p.cfg.role})`).join(", ") }) + "\n\n" + text;
      }
      const reply = (await e.sendMeeting(text, images)).trim();
      if (!this.active) return;
      if (!reply || (!floor && PASS_RE.test(reply))) this.add({ ts: Date.now(), from: e.cfg.id, name: e.cfg.name, kind: "pass", text: "" });
      else this.add({ ts: Date.now(), from: e.cfg.id, name: e.cfg.name, kind: "say", text: reply });
    }).catch(() => {});
    this.chain.set(e.cfg.id, next);
  }

  // Ends the meeting: everybody is released, optionally a summary is written, posted to each chat and appended to memory.
  async end(opts: { summary: boolean; memory: boolean }) {
    if (!this.active) return;
    this.endedAt = Date.now();
    for (const e of this.people) {
      this.unhook.get(e.cfg.id)?.();
      if (e.status === "working" && e.inMeetingTurn) await e.interrupt();
      e.inMeeting = false;
    }
    this.hands.clear();
    const spoken = this.transcript.some((m) => m.kind === "say");
    if (opts.summary && spoken) {
      this.summarizing = true;
      this.emit("state");
      try { await this.summarize(); } catch (err) { this.summary = t("server.meeting.summaryFailed", { message: (err as Error).message }); }
      this.summarizing = false;
    }
    const title = this.topic || t("server.meeting.untitled");
    for (const e of this.people) {
      if (!this.joined.has(e.cfg.id)) continue;
      e.meetingOver(title, this.summary);
      if (opts.memory && this.summary && e.cfg.memoryFile) {
        try { fs.appendFileSync(e.cfg.memoryFile, `\n\n## ${t("server.meeting.memoryTitle", { date: new Date().toISOString().slice(0, 10), topic: title })}\n\n${this.summary}\n`); } catch {}
      }
    }
    this.persist();
    this.emit("state");
    this.emit("ended");
    for (const e of this.people) e.poke(); // tasks and colleague messages that waited for the meeting
  }

  private plainTranscript(): string {
    return this.transcript.filter((m) => m.kind === "say").map((m) => `${m.from === "user" ? t("server.meeting.boss") : m.name}: ${m.text}`).join("\n");
  }

  // A small one-shot model call with no tools; the result is a summary plus follow-up tasks per person.
  private async summarize() {
    const names = this.people.map((e) => e.cfg.name).join(", ");
    const q = query({
      prompt: t("server.meeting.summaryPrompt", { topic: this.topic || t("server.meeting.untitled"), names, transcript: this.plainTranscript() }),
      options: { cwd: this.cwd, model: "claude-haiku-4-5", tools: [], maxTurns: 1, persistSession: false, settingSources: [], systemPrompt: t("server.meeting.summarySystem") },
    });
    let out = "";
    for await (const m of q) if (m.type === "result" && m.subtype === "success") out = m.result;
    const json = out.match(/\{[\s\S]*\}/);
    let parsed: { summary?: unknown; tasks?: unknown } = {};
    try { parsed = json ? JSON.parse(json[0]) : {}; } catch {}
    this.summary = typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : out.trim();
    const tasks: MeetingTask[] = [];
    if (Array.isArray(parsed.tasks)) for (const x of parsed.tasks) {
      const to = String((x as Record<string, unknown>)?.to ?? "").trim().toLowerCase(), task = String((x as Record<string, unknown>)?.task ?? "").trim();
      const e = this.people.find((p) => p.cfg.name.toLowerCase() === to || p.cfg.id === to);
      if (e && task) tasks.push({ to: e.cfg.id, name: e.cfg.name, task });
    }
    this.tasks = tasks;
  }

  private persist() {
    this.store.saveMeeting(this.id, this.state());
  }
}
