import fs from "node:fs";
import path from "node:path";
import type { EmployeeConfig } from "./employee.js";
import { getSettings, t } from "./runtime.js";

export const expandHome = (p: string) => path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? ""));

interface AgentFile {
  meta: Record<string, string>;
  body: string;
}

// Parses a Claude Code style agent definition: YAML-ish frontmatter between --- lines, then the prompt body.
export function parseAgentFile(file: string): AgentFile {
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2].trim() };
}

const PALETTE = ["#e06c75", "#61afef", "#98c379", "#c678dd", "#e5c07b", "#56b6c2", "#d19a66", "#f78fb3", "#7dd3fc", "#a3e635", "#fb923c", "#f472b6"];
const HAIR = ["#2b1d14", "#1c1c1c", "#4a2c1a", "#b8471f", "#e6c064", "#5a3825", "#7a5230", "#3b2a20"];
const STYLES = ["short", "long", "bun", "ponytail", "curly", "short"];

export function defaultLook(id: string, color: string): Record<string, unknown> {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hairStyle = STYLES[(h >> 3) % STYLES.length];
  return {
    skin: ["#f1c9a5", "#e9bd9a", "#d9a877", "#f6d3bd", "#c68642"][h % 5],
    hair: HAIR[h % HAIR.length],
    hairStyle,
    top: color,
    bottom: ["#2f3548", "#23272f", "#3b3f4a"][(h >> 5) % 3],
    accessory: ["none", "none", "glasses", "headphones"][(h >> 7) % 4],
    fem: ["long", "bun", "ponytail"].includes(hairStyle),
  };
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u")
    .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function parseJsonMaybe<T>(v: string | undefined): T | undefined {
  if (!v || !v.trim().startsWith("{")) return undefined;
  try { return JSON.parse(v) as T; } catch { return undefined; }
}

// Memory file: the configured name, or an existing legacy name inside the folder.
function findMemoryFile(dir: string): string {
  const { memoryFile } = getSettings();
  const preferred = path.join(dir, memoryFile);
  if (fs.existsSync(preferred)) return preferred;
  for (const alt of ["memory.md", "hafiza.md"]) if (fs.existsSync(path.join(dir, alt))) return path.join(dir, alt);
  return preferred;
}

// Builds an employee config from its folder (agent.md + memory + skills/).
export function loadEmployee(dir: string, index: number): EmployeeConfig {
  const agentFile = path.join(dir, "agent.md");
  const { meta, body } = fs.existsSync(agentFile) ? parseAgentFile(agentFile) : { meta: {}, body: "" };
  const id = path.basename(dir);
  const name = meta.name ?? id;
  const role = meta.role ?? meta.description?.split(/[.\n]/)[0].slice(0, 40) ?? t("server.defaultRole");
  const color = meta.color ?? PALETTE[index % PALETTE.length];
  const settings = getSettings();
  const cwd = meta.cwd ? expandHome(meta.cwd) : settings.cwd;
  const tools = meta.tools ? meta.tools.replace(/^\[|\]$/g, "").split(",").map((x) => x.trim()).filter(Boolean) : undefined;
  const cfg: EmployeeConfig = {
    id, name, role, color, cwd, dir, agentFile,
    systemPrompt: body || t("server.defaultPrompt", { name, role }),
    memoryFile: findMemoryFile(dir),
    pluginDir: dir,
    look: parseJsonMaybe<Record<string, unknown>>(meta.look) ?? defaultLook(id, color),
    model: meta.model,
    allowedTools: tools,
    permissionMode: meta.permissionMode as EmployeeConfig["permissionMode"],
    refreshHours: meta.refreshHours !== undefined ? Number(meta.refreshHours) : settings.refreshHours,
    effort: meta.effort as EmployeeConfig["effort"],
    hired: meta.hired ?? fs.statSync(dir).birthtime.toISOString().slice(0, 10),
  };
  ensureDirs(cfg);
  return cfg;
}

function ensureDirs(cfg: EmployeeConfig) {
  fs.mkdirSync(cfg.cwd, { recursive: true });
  fs.mkdirSync(path.join(cfg.dir!, "skills"), { recursive: true });
  // Claude Code loads a folder as a plugin only with a manifest; create a minimal one.
  const manifest = path.join(cfg.dir!, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(manifest)) {
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ name: cfg.id, description: `${cfg.name} — ${cfg.role}`, version: "1.0.0" }, null, 2));
  }
}

export function loadEmployees(): EmployeeConfig[] {
  const { employeesDir } = getSettings();
  fs.mkdirSync(employeesDir, { recursive: true });
  const out: EmployeeConfig[] = [];
  for (const name of fs.readdirSync(employeesDir).sort()) {
    const dir = path.join(employeesDir, name);
    if (name.startsWith("_") || name.startsWith(".") || !fs.statSync(dir).isDirectory()) continue;
    if (!fs.existsSync(path.join(dir, "agent.md"))) continue;
    out.push(loadEmployee(dir, out.length));
  }
  return out;
}

// Serializes an employee back to its agent.md (frontmatter + prompt body).
export function writeAgentFile(cfg: EmployeeConfig) {
  if (!cfg.agentFile) return;
  const lines = ["---", `name: ${cfg.name}`, `role: ${cfg.role}`, `color: ${cfg.color}`];
  if (cfg.hired) lines.push(`hired: ${cfg.hired}`);
  if (cfg.model) lines.push(`model: ${cfg.model}`);
  if (cfg.effort) lines.push(`effort: ${cfg.effort}`);
  if (cfg.permissionMode && cfg.permissionMode !== "default") lines.push(`permissionMode: ${cfg.permissionMode}`);
  if (cfg.allowedTools?.length) lines.push(`tools: ${cfg.allowedTools.join(", ")}`);
  if (cfg.refreshHours !== undefined && cfg.refreshHours !== getSettings().refreshHours) lines.push(`refreshHours: ${cfg.refreshHours}`);
  if (cfg.cwd !== getSettings().cwd) lines.push(`cwd: ${cfg.cwd}`);
  lines.push(`look: ${JSON.stringify(cfg.look)}`, "---", cfg.systemPrompt.trim(), "");
  fs.writeFileSync(cfg.agentFile, lines.join("\n"));
}

// Creates <employeesDir>/<id>/ with agent.md, memory and skills/ for a newly hired employee.
export function createEmployeeDir(input: { name: string; role: string; prompt: string; color: string; look: Record<string, unknown>; model?: string; effort?: EmployeeConfig["effort"]; permissionMode?: EmployeeConfig["permissionMode"] }): string {
  const { employeesDir, memoryFile, refreshHours, cwd } = getSettings();
  let id = slug(input.name) || "employee";
  let dir = path.join(employeesDir, id);
  for (let n = 2; fs.existsSync(dir); n++) { id = `${slug(input.name) || "employee"}-${n}`; dir = path.join(employeesDir, id); }
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(dir, memoryFile), t("server.memoryHeader", { name: input.name }));
  const cfg: EmployeeConfig = {
    id, name: input.name, role: input.role, color: input.color, look: input.look,
    systemPrompt: input.prompt, cwd, dir, agentFile: path.join(dir, "agent.md"),
    model: input.model, effort: input.effort, permissionMode: input.permissionMode,
    hired: new Date().toISOString().slice(0, 10), refreshHours,
  };
  writeAgentFile(cfg);
  return dir;
}

export function archiveEmployeeDir(dir: string) {
  const archive = path.join(path.dirname(dir), "_archive");
  fs.mkdirSync(archive, { recursive: true });
  const target = path.join(archive, `${path.basename(dir)}-${new Date().toISOString().slice(0, 10)}`);
  fs.renameSync(dir, fs.existsSync(target) ? `${target}-${Date.now()}` : target);
  return target;
}

export function listSkills(pluginDir?: string): Array<{ name: string; description: string }> {
  if (!pluginDir) return [];
  const dir = path.join(pluginDir, "skills");
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ name: string; description: string }> = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, name, "SKILL.md");
    if (!fs.existsSync(f)) continue;
    const { meta } = parseAgentFile(f);
    out.push({ name: meta.name ?? name, description: meta.description ?? "" });
  }
  return out;
}

export function writeSkill(pluginDir: string, name: string, description: string, body: string) {
  const dir = path.join(pluginDir, "skills", slug(name));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${slug(name)}\ndescription: ${description.replace(/\n/g, " ")}\n---\n${body.trim()}\n`);
  return slug(name);
}

export function readSkill(pluginDir: string, name: string): { name: string; description: string; body: string } | null {
  const f = path.join(pluginDir, "skills", name, "SKILL.md");
  if (!fs.existsSync(f)) return null;
  const { meta, body } = parseAgentFile(f);
  return { name, description: meta.description ?? "", body };
}

export function deleteSkill(pluginDir: string, name: string) {
  const dir = path.join(pluginDir, "skills", name);
  if (fs.existsSync(path.join(dir, "SKILL.md"))) fs.rmSync(dir, { recursive: true, force: true });
}

// Mirrors office employees into <cwd>/.claude/agents so a terminal `claude` in the project can delegate to them.
export function syncClaudeAgents(emps: EmployeeConfig[]) {
  const { cwd, syncClaudeAgents: enabled } = getSettings();
  if (!enabled) return;
  const dir = path.join(cwd, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  const markerRe = /<!-- pixel-office:|<!-- ofis:/;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f.endsWith(".md") && markerRe.test(fs.readFileSync(p, "utf8")) && !emps.some((e) => `${e.id}.md` === f)) fs.unlinkSync(p);
  }
  for (const e of emps) {
    const rel = (p?: string) => (p ? path.relative(cwd, p) : undefined);
    const mem = rel(e.memoryFile);
    const skills = e.pluginDir ? path.join(rel(e.pluginDir)!, "skills") : undefined;
    const body = [
      `---`,
      `name: ${e.id}`,
      `description: ${t("server.agentSync.description", { name: e.name, role: e.role, roleLower: e.role.toLowerCase() })}`,
      e.model ? `model: ${e.model}` : null,
      e.allowedTools?.length ? `tools: ${e.allowedTools.join(", ")}` : null,
      `---`,
      t("server.agentSync.marker"),
      ``,
      e.systemPrompt,
      mem ? "\n" + t("server.agentSync.memory", { file: mem }) : null,
      skills ? "\n" + t("server.agentSync.skills", { dir: skills }) : null,
    ].filter((l) => l !== null).join("\n");
    fs.writeFileSync(path.join(dir, `${e.id}.md`), body + "\n");
  }
}
