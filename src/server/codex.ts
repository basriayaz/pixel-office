import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";

// The second engine: OpenAI's Codex CLI, signed in with the user's ChatGPT plan (`codex login`). An employee whose model is a
// Codex model runs through `codex exec`, one process per turn, resumed by thread id. Everything an employee is made of on the
// Claude side is handed over explicitly, because Codex reads none of it by itself:
//   agent.md prompt + memory + office rules → developer_instructions
//   CLAUDE.md of the project                → project_doc_fallback_filenames
//   skills (employee's and the project's)   → an index with full SKILL.md paths inside the instructions (same format on both sides)
//   office tools                            → the office's MCP endpoint over HTTP, tools pre-approved

export interface CodexModel { id: string; name: string; desc: string; efforts: string[] }

let catalog: CodexModel[] | undefined;
// Models the signed-in account may use; empty when Codex is not installed or not signed in.
export function codexModels(refresh = false): CodexModel[] {
  if (catalog && !refresh) return catalog;
  try {
    const raw = JSON.parse(execFileSync("codex", ["debug", "models"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, maxBuffer: 32 * 1024 * 1024 }));
    const list: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : raw.models ?? [];
    catalog = list.filter((m) => m.visibility === "list").map((m) => ({
      id: String(m.slug), name: String(m.display_name ?? m.slug), desc: String(m.description ?? ""),
      efforts: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []).map((x: unknown) => String((x as { effort?: string })?.effort ?? x)),
    }));
  } catch { catalog = []; }
  return catalog;
}
export const isCodexModel = (model?: string) => !!model && (codexModels().some((m) => m.id === model) || /^(gpt-|codex-)/.test(model));

export type CodexItem =
  | { type: "agent_message"; text: string }
  | { type: "reasoning"; text?: string }
  | { type: "command_execution"; command: string; status?: string; exit_code?: number | null }
  | { type: "file_change"; changes?: Array<{ path: string; kind: string }> }
  | { type: "mcp_tool_call"; server: string; tool: string; arguments?: Record<string, unknown>; error?: { message: string } | null }
  | { type: "web_search"; query?: string }
  | { type: "todo_list" }
  | { type: "error"; message: string };

export interface CodexTurn {
  cwd: string;
  prompt: string;
  model: string;
  effort?: string;
  instructions: string;
  thread?: string;               // resume this conversation
  sandbox: "read-only" | "workspace-write" | "full";
  writableDirs?: string[];
  images?: string[];             // files on disk
  mcpUrl?: string;
  persist?: boolean;             // false = throw-away session
}

export interface CodexHandlers {
  onThread(id: string): void;
  onItemStarted(item: CodexItem): void;
  onItem(item: CodexItem): void;
}

export interface CodexResult { ok: boolean; error?: string; inputTokens: number; outputTokens: number; calls: number; notFound?: boolean }

const toml = (v: unknown) => JSON.stringify(v); // JSON strings and arrays of strings are valid TOML

// One turn. Resolves when the process ends; `kill` stops it (the boss pressed stop).
export function runCodexTurn(turn: CodexTurn, h: CodexHandlers): { done: Promise<CodexResult>; kill: () => void } {
  const args = ["exec"];
  if (turn.thread) args.push("resume", turn.thread);
  args.push("--json", "--skip-git-repo-check", "--ignore-user-config", "-m", turn.model);
  if (!turn.thread) args.push("-C", turn.cwd);
  if (turn.persist === false) args.push("--ephemeral");
  if (turn.sandbox === "full") args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (!turn.thread) args.push("-s", turn.sandbox);
  else args.push("-c", `sandbox_mode=${toml(turn.sandbox)}`);
  // `resume` takes no -s / --add-dir, so everything about the sandbox goes through config keys that both forms accept
  if (turn.sandbox === "workspace-write") args.push("-c", "sandbox_workspace_write.network_access=true", "-c", `sandbox_workspace_write.writable_roots=${toml(turn.writableDirs ?? [])}`);
  if (turn.effort) args.push("-c", `model_reasoning_effort=${toml(turn.effort)}`);
  args.push("-c", `developer_instructions=${toml(turn.instructions)}`, "-c", `project_doc_fallback_filenames=${toml(["CLAUDE.md"])}`);
  if (turn.mcpUrl) args.push("-c", `mcp_servers.office.url=${toml(turn.mcpUrl)}`, "-c", `mcp_servers.office.default_tools_approval_mode="approve"`);
  for (const im of turn.images ?? []) args.push("-i", im);
  args.push("-"); // the prompt comes on stdin: no length or quoting limits

  let child: ChildProcess | undefined;
  let killed = false;
  const done = new Promise<CodexResult>((resolve) => {
    const res: CodexResult = { ok: false, inputTokens: 0, outputTokens: 0, calls: 1 };
    let buf = "", err = "";
    try { child = spawn("codex", args, { cwd: turn.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env }); }
    catch (e) { resolve({ ...res, error: (e as Error).message }); return; }
    child.on("error", (e) => resolve({ ...res, error: (e as NodeJS.ErrnoException).code === "ENOENT" ? "codex is not installed (npm i -g @openai/codex, then codex login)" : e.message }));
    child.stdin?.end(turn.prompt);
    child.stderr?.on("data", (d) => { err = (err + d).slice(-4000); });
    child.stdout?.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let ev: { type: string; thread_id?: string; item?: CodexItem; usage?: { input_tokens?: number; output_tokens?: number }; message?: string; error?: { message?: string } };
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "thread.started" && ev.thread_id) h.onThread(ev.thread_id);
        else if (ev.type === "item.started" && ev.item) h.onItemStarted(ev.item);
        else if (ev.type === "item.completed" && ev.item) {
          if (ev.item.type === "command_execution" || ev.item.type === "mcp_tool_call" || ev.item.type === "file_change" || ev.item.type === "web_search") res.calls++;
          if (ev.item.type === "error" && /metadata .* not found/i.test(ev.item.message)) continue; // harmless notice about an unknown model name
          h.onItem(ev.item);
        } else if (ev.type === "turn.completed") { res.ok = true; res.inputTokens = ev.usage?.input_tokens ?? 0; res.outputTokens = ev.usage?.output_tokens ?? 0; }
        else if (ev.type === "turn.failed" || ev.type === "error") res.error = readable(ev.error?.message ?? ev.message ?? "turn failed");
      }
    });
    child.on("close", (code) => {
      if (killed) return resolve({ ...res, ok: false, error: "interrupted" });
      if (!res.ok && !res.error) res.error = err.trim().split("\n").pop() || `codex exited with ${code}`;
      if (!res.ok && turn.thread && /no (rollout|session|thread|conversation)|not found|could not find/i.test(`${res.error} ${err}`)) res.notFound = true;
      resolve(res);
    });
  });
  return { done, kill: () => { killed = true; try { child?.kill("SIGTERM"); } catch {} } };
}

// API errors arrive as JSON inside a string; show the sentence, not the envelope.
function readable(message: string): string {
  try { const j = JSON.parse(message); return String(j?.error?.message ?? j?.message ?? message); } catch { return message; }
}

// Skills index for the instructions: Codex uses the same SKILL.md format but only looks into its own folders.
export function skillsIndex(skills: Array<{ name: string; description: string; file: string }>): string {
  return skills.filter((s) => fs.existsSync(s.file)).map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").slice(0, 240)} → ${s.file}`).join("\n");
}
export const skillFile = (dir: string, name: string) => path.join(dir, name, "SKILL.md");
