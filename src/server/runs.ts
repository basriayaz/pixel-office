import path from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { appendJsonLineSync, readJsonLines } from "./fsutil.js";

// One line per task run: from the moment a task became "doing" until it left it and its owner's turn ended.
export type RunStatus = "done" | "review" | "blocked" | "stopped" | "error" | "todo";
export interface Run {
  task: number;
  emp: string;
  empName: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  cost: number;
  codexTokens?: number;
  status: RunStatus;
  session?: string;
}

export class RunLog {
  private file: string;
  constructor(dir: string) { this.file = path.join(dir, "runs.jsonl"); }

  add(run: Run) { appendJsonLineSync(this.file, run); }

  // Read on demand: the drawer asks for one task now and then, nothing keeps this in memory.
  forTask(id: number) {
    const runs = readJsonLines<Run>(this.file, (r) => r.task === id);
    const total = runs.reduce((a, r) => ({ cost: a.cost + (r.cost || 0), durationMs: a.durationMs + (r.durationMs || 0), codexTokens: a.codexTokens + (r.codexTokens || 0) }), { cost: 0, durationMs: 0, codexTokens: 0 });
    total.cost = Math.round(total.cost * 1e6) / 1e6;
    return { runs, total };
  }
}

// ---- transcript of a task's session (best effort, Claude only) ----
export interface TranscriptLine { role: "user" | "assistant" | "tool"; text: string; ts?: number; tool?: string }
const MAX_LINES = 200, TOOL_CHARS = 600;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const str = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));

export async function sessionTranscript(session: string, cwd: string): Promise<TranscriptLine[]> {
  let msgs = await getSessionMessages(session, { dir: cwd }).catch(() => []);
  if (!msgs.length) msgs = await getSessionMessages(session).catch(() => []); // the folder moved (worktree, new office folder): look everywhere
  const out: TranscriptLine[] = [];
  for (const m of msgs) {
    if (m.parent_tool_use_id) continue; // subagents' inner steps: their result shows up as a tool line
    const msg = m.message as { content?: unknown } | undefined;
    const content = msg?.content;
    const ts = typeof (m as { timestamp?: unknown }).timestamp === "string" ? Date.parse((m as unknown as { timestamp: string }).timestamp) || undefined : undefined;
    if (typeof content === "string") { if (content.trim()) out.push({ role: m.type === "assistant" ? "assistant" : "user", text: content, ...(ts ? { ts } : {}) }); continue; }
    if (!Array.isArray(content)) continue;
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ role: m.type === "assistant" ? "assistant" : "user", text: b.text, ...(ts ? { ts } : {}) });
      else if (b.type === "tool_use") out.push({ role: "tool", tool: String(b.name ?? "tool"), text: clip(str(b.input), TOOL_CHARS), ...(ts ? { ts } : {}) });
      else if (b.type === "tool_result") {
        const c = b.content;
        const text = Array.isArray(c) ? c.map((x: Record<string, unknown>) => (x.type === "text" ? String(x.text ?? "") : `[${String(x.type)}]`)).join("\n") : str(c);
        out.push({ role: "tool", tool: "result", text: clip(text, TOOL_CHARS), ...(ts ? { ts } : {}) });
      }
    }
  }
  return out.slice(-MAX_LINES);
}
