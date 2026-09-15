import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Package root (where web/, locales/, templates/ live) — works from src/ (tsx) and dist/ (built).
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface OfficeSettings {
  locale: string;
  port: number;
  host: string;
  employeesDir: string;
  dataDir: string;
  memoryFile: string;
  cwd: string;
  syncClaudeAgents: boolean;
  refreshHours: number;
}

export const CONFIG_DIR = ".pixel-office";

const DEFAULTS = {
  locale: "en",
  port: 4747,
  host: "127.0.0.1",
  employeesDir: `${CONFIG_DIR}/employees`,
  dataDir: `${CONFIG_DIR}/data`,
  memoryFile: "memory.md",
  cwd: ".",
  syncClaudeAgents: true,
  refreshHours: 24,
};

export function configPath(projectDir: string) {
  return path.join(projectDir, CONFIG_DIR, "config.json");
}

export function loadSettings(projectDir: string, overrides: Partial<OfficeSettings> = {}): OfficeSettings {
  const file = configPath(projectDir);
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const merged = { ...DEFAULTS, ...raw, ...stripUndefined(overrides) };
  const abs = (p: string) => path.resolve(projectDir, p.replace(/^~(?=$|\/)/, process.env.HOME ?? ""));
  return {
    locale: String(merged.locale),
    port: Number(process.env.PORT ?? merged.port),
    host: String(process.env.HOST ?? merged.host),
    employeesDir: abs(merged.employeesDir),
    dataDir: abs(merged.dataDir),
    memoryFile: String(merged.memoryFile),
    cwd: abs(merged.cwd),
    syncClaudeAgents: merged.syncClaudeAgents !== false,
    refreshHours: Number(merged.refreshHours),
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// `pixel-office init`: creates .pixel-office/{config.json, employees/_template}, adds data dir to .gitignore.
export function initProject(projectDir: string, opts: { locale?: string; memoryInGit?: boolean } = {}) {
  const locale = opts.locale ?? "en";
  const dir = path.join(projectDir, CONFIG_DIR);
  fs.mkdirSync(path.join(dir, "employees"), { recursive: true });
  const cfg = configPath(projectDir);
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, JSON.stringify({ locale, port: DEFAULTS.port, employeesDir: DEFAULTS.employeesDir, dataDir: DEFAULTS.dataDir, memoryFile: DEFAULTS.memoryFile, cwd: ".", syncClaudeAgents: true, refreshHours: 24 }, null, 2) + "\n");
  }
  const tplSrc = path.join(PKG_ROOT, "templates", "employee", locale);
  const tplDst = path.join(dir, "employees", "_template");
  if (!fs.existsSync(tplDst) && fs.existsSync(tplSrc)) fs.cpSync(tplSrc, tplDst, { recursive: true });
  const gi = path.join(projectDir, ".gitignore");
  const lines = [`${CONFIG_DIR}/data/`];
  if (opts.memoryInGit === false) lines.push(`${CONFIG_DIR}/employees/*/${DEFAULTS.memoryFile}`);
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  const missing = lines.filter((l) => !existing.split(/\r?\n/).includes(l));
  if (missing.length) fs.writeFileSync(gi, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
  return { configFile: cfg, employeesDir: path.join(dir, "employees") };
}
