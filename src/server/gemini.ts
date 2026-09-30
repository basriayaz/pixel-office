import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

// The third engine: Google's Gemini CLI, with a Gemini API key. Like Codex, one process per turn (`gemini -p -o stream-json`),
// the conversation resumed by session id (`--resume <uuid>`, verified with gemini-cli 0.35). What the employee is made of goes in
// through a system settings file of our own (GEMINI_CLI_SYSTEM_SETTINGS_PATH: it outranks the user's ~/.gemini/settings.json
// without touching it):
//   office tools        → mcpServers.office over HTTP, trusted (no confirmation)
//   CLAUDE.md           → read as a context file next to GEMINI.md
//   agent.md + memory   → in front of the prompt, when a session starts or the instructions changed since its last turn

export type GeminiEvent =
  | { type: "init"; session_id: string; model: string }
  | { type: "message"; role: "user" | "assistant"; content: string; delta?: boolean }
  | { type: "tool_use"; tool_name: string; tool_id: string; parameters: Record<string, unknown> }
  | { type: "tool_result"; tool_id: string; status: "success" | "error"; error?: { message: string } }
  | { type: "error"; severity: "warning" | "error"; message: string }
  | { type: "result"; status: "success" | "error"; error?: { message: string }; stats?: { input_tokens?: number; output_tokens?: number; cached?: number; tool_calls?: number } };

export interface GeminiTurn {
  cwd: string;
  prompt: string;
  model: string;
  apiKey: string;
  session?: string;               // resume this conversation
  approval: "plan" | "auto_edit" | "yolo";
  includeDirs?: string[];
  images?: string[];              // files on disk, referenced with @path
  mcpUrl?: string;
  extraMcp?: Array<{ id: string; url: string; tools: string[] }>; // integrations (through the office gateway): only their read-only tools
  settingsFile: string;           // where this employee's system settings file is written
}

export interface GeminiHandlers {
  onSession(id: string): void;
  onText(chunk: string): void;    // assistant text as it streams
  onTool(ev: Extract<GeminiEvent, { type: "tool_use" }>): void;
  onWarning(message: string): void;
}

export interface GeminiResult { ok: boolean; error?: string; inputTokens: number; outputTokens: number; cachedTokens: number; calls: number; notFound?: boolean }

// What `--resume <id>` prints when the session does not exist (gemini-cli sessionUtils.js).
const RESUME_FAILED = /Invalid session identifier|No previous sessions found|session .* not found/i;

export function runGeminiTurn(turn: GeminiTurn, h: GeminiHandlers): { done: Promise<GeminiResult>; kill: () => void } {
  const settings = {
    security: { auth: { selectedType: "gemini-api-key" } },
    context: { fileName: ["GEMINI.md", "CLAUDE.md"] },
    ...(turn.mcpUrl || turn.extraMcp?.length ? { mcpServers: {
      ...(turn.mcpUrl ? { office: { httpUrl: turn.mcpUrl, trust: true } } : {}),
      ...Object.fromEntries((turn.extraMcp ?? []).map((m) => [m.id, { httpUrl: m.url, includeTools: m.tools, trust: true }])),
    } } : {}),
  };
  fs.mkdirSync(path.dirname(turn.settingsFile), { recursive: true });
  fs.writeFileSync(turn.settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });

  const args = ["-p", "", "-o", "stream-json", "-m", turn.model, "--approval-mode", turn.approval];
  if (turn.session) args.push("--resume", turn.session);
  for (const d of turn.includeDirs ?? []) args.push("--include-directories", d);
  // the prompt comes on stdin (-p "" only switches to headless mode): no length or quoting limits
  const prompt = turn.prompt + (turn.images?.length ? "\n\n" + turn.images.map((f) => `@${f}`).join(" ") : "");

  let child: ChildProcess | undefined;
  let killed = false;
  const done = new Promise<GeminiResult>((resolve) => {
    const res: GeminiResult = { ok: false, inputTokens: 0, outputTokens: 0, cachedTokens: 0, calls: 1 };
    let buf = "", err = "";
    const env = { ...process.env, GEMINI_API_KEY: turn.apiKey, GEMINI_CLI_SYSTEM_SETTINGS_PATH: turn.settingsFile, GEMINI_CLI_NO_RELAUNCH: "true" };
    try { child = spawn("gemini", args, { cwd: turn.cwd, stdio: ["pipe", "pipe", "pipe"], env }); }
    catch (e) { resolve({ ...res, error: (e as Error).message }); return; }
    child.on("error", (e) => resolve({ ...res, error: (e as NodeJS.ErrnoException).code === "ENOENT" ? "gemini is not installed (npm i -g @google/gemini-cli)" : e.message }));
    child.stdin?.end(prompt);
    child.stderr?.on("data", (d) => { err = (err + d).slice(-4000); });
    child.stdout?.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let ev: GeminiEvent;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "init" && ev.session_id) h.onSession(ev.session_id);
        else if (ev.type === "message" && ev.role === "assistant" && ev.content) h.onText(ev.content);
        else if (ev.type === "tool_use") { res.calls++; h.onTool(ev); }
        else if (ev.type === "error") { if (ev.severity === "warning") h.onWarning(ev.message); else res.error = ev.message; }
        else if (ev.type === "result") {
          res.ok = ev.status === "success";
          if (!res.ok) res.error = ev.error?.message ?? res.error ?? "turn failed";
          res.inputTokens = ev.stats?.input_tokens ?? 0;
          res.outputTokens = ev.stats?.output_tokens ?? 0;
          res.cachedTokens = ev.stats?.cached ?? 0;
        }
      }
    });
    child.on("close", (code) => {
      if (killed) return resolve({ ...res, ok: false, error: "interrupted" });
      if (!res.ok && !res.error) res.error = lastError(err) || `gemini exited with ${code}`;
      if (!res.ok && turn.session && (RESUME_FAILED.test(res.error ?? "") || RESUME_FAILED.test(err))) res.notFound = true;
      resolve(res);
    });
  });
  return { done, kill: () => { killed = true; try { child?.kill("SIGTERM"); } catch {} } };
}

// stderr carries notices (skills, config warnings) before the error: the line that says what went wrong, without its stack.
function lastError(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l && !/^at /.test(l));
  const hit = [...lines].reverse().find((l) => /error/i.test(l)) ?? lines.pop() ?? "";
  return hit.replace(/^An unexpected critical error occurred:\s*/i, "").replace(/^Error:\s*/, "").slice(0, 400);
}
