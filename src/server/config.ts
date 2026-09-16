import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Package root (where web/, locales/, templates/ live) — works from src/ (tsx) and dist/ (built).
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const THEMES = ["default", "football", "fashion", "gothic", "music"] as const;
export type Theme = (typeof THEMES)[number];

export interface OfficeDef {
  id: string;
  name: string;
  employeesDir: string;
  cwd: string;
  extraEmployees: string[];
  theme: Theme;
}

export interface OfficeSettings {
  locale: string;
  port: number;
  host: string;
  dataDir: string;
  memoryFile: string;
  syncClaudeAgents: boolean;
  refreshHours: number;
  multiOffice: boolean;
  offices: OfficeDef[];
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

const slugId = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function configPath(projectDir: string) {
  return path.join(projectDir, CONFIG_DIR, "config.json");
}

export type RawConfig = Record<string, unknown> & { offices?: Array<Record<string, unknown>> };

export function readRawConfig(projectDir: string): RawConfig {
  const file = configPath(projectDir);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

export function writeRawConfig(projectDir: string, raw: RawConfig) {
  fs.mkdirSync(path.dirname(configPath(projectDir)), { recursive: true });
  fs.writeFileSync(configPath(projectDir), JSON.stringify(raw, null, 2) + "\n");
}

export const absPath = (projectDir: string, p: string) => path.resolve(projectDir, String(p).replace(/^~(?=$|\/)/, process.env.HOME ?? ""));
export const officeIdOf = (s: string, fallback: string) => slugId(s) || fallback;

// One office definition from its raw config entry.
export function officeDefFromRaw(projectDir: string, o: Record<string, unknown>, i: number, rootCwd: string): OfficeDef {
  const abs = (p: string) => absPath(projectDir, p);
  const id = officeIdOf(String(o.id ?? o.name ?? `office-${i + 1}`), `office-${i + 1}`);
  return {
    id,
    name: String(o.name ?? id),
    employeesDir: abs(String(o.employeesDir ?? `${CONFIG_DIR}/employees/${id}`)),
    cwd: o.cwd ? abs(String(o.cwd)) : rootCwd,
    extraEmployees: Array.isArray(o.employees) ? (o.employees as string[]).map(abs) : [],
    theme: (THEMES as readonly string[]).includes(String(o.theme)) ? (o.theme as Theme) : "default",
  };
}

export function loadSettings(projectDir: string): OfficeSettings {
  const raw = readRawConfig(projectDir);
  const merged = { ...DEFAULTS, ...raw } as Record<string, unknown>;
  const abs = (p: string) => absPath(projectDir, p);
  const rootCwd = abs(String(merged.cwd));
  const multiOffice = Array.isArray(raw.offices) && raw.offices.length > 0;
  const offices: OfficeDef[] = multiOffice
    ? (raw.offices as Array<Record<string, unknown>>).map((o, i) => officeDefFromRaw(projectDir, o, i, rootCwd))
    : [{ id: "main", name: "", employeesDir: abs(String(merged.employeesDir)), cwd: rootCwd, extraEmployees: [], theme: (THEMES as readonly string[]).includes(String(merged.theme)) ? (merged.theme as Theme) : "default" }];
  const ids = new Set<string>();
  for (const o of offices) {
    if (ids.has(o.id)) throw new Error(`config.json: office id "${o.id}" is used twice`);
    ids.add(o.id);
  }
  return {
    locale: String(merged.locale),
    port: Number(process.env.PORT ?? merged.port),
    host: String(process.env.HOST ?? merged.host),
    dataDir: abs(String(merged.dataDir)),
    memoryFile: String(merged.memoryFile),
    syncClaudeAgents: merged.syncClaudeAgents !== false,
    refreshHours: Number(merged.refreshHours),
    multiOffice,
    offices,
  };
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
  if (opts.memoryInGit === false) lines.push(`${CONFIG_DIR}/employees/**/${DEFAULTS.memoryFile}`);
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  const missing = lines.filter((l) => !existing.split(/\r?\n/).includes(l));
  if (missing.length) fs.writeFileSync(gi, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
  return { configFile: cfg, employeesDir: path.join(dir, "employees") };
}
