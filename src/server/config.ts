import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Package root (where web/, locales/, templates/ live) — works from src/ (tsx) and dist/ (built).
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const THEMES = ["default", "football", "fashion", "gothic", "music", "travel"] as const;
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
  sickness: boolean; // employees occasionally fall ill for a few minutes
  multiOffice: boolean;
  offices: OfficeDef[];
}

export const CONFIG_DIR = ".pixel-office";
export const HOME_DIR = () => process.env.PIXEL_OFFICE_HOME || path.join(os.homedir(), CONFIG_DIR);

/**
 * Where Pixel Office keeps its files.
 *  - project mode: `<project>/.pixel-office/` (config.json, employees/, data/); relative paths in config.json resolve
 *    against the project folder; employees work in the project by default.
 *  - global mode: `~/.pixel-office/` (or $PIXEL_OFFICE_HOME); relative paths resolve against that folder; employees work
 *    in the user's home folder unless the office/employee sets a cwd.
 */
export interface Root {
  mode: "project" | "global";
  root: string;      // folder that holds config.json
  base: string;      // relative paths in config.json resolve against this
  defaultCwd: string;
}

export function projectRoot(projectDir: string): Root {
  const base = path.resolve(projectDir);
  return { mode: "project", root: path.join(base, CONFIG_DIR), base, defaultCwd: base };
}
export function globalRoot(): Root {
  const root = path.resolve(HOME_DIR());
  return { mode: "global", root, base: root, defaultCwd: os.homedir() };
}
export const hasProjectConfig = (projectDir: string) => fs.existsSync(path.join(projectDir, CONFIG_DIR, "config.json"));

// `--dir X` → that project; `--global` → home; otherwise the current folder if it has been `init`ed, else home.
export function resolveRoot(opts: { dir?: string; global?: boolean; cwd?: string } = {}): Root {
  if (opts.dir) return projectRoot(opts.dir);
  if (opts.global) return globalRoot();
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  // ~/.pixel-office is the global home, not a project config of the home folder.
  return hasProjectConfig(cwd) && path.join(cwd, CONFIG_DIR) !== globalRoot().root ? projectRoot(cwd) : globalRoot();
}
// The server gets its root from the CLI through env vars.
export const rootToEnv = (R: Root) => ({ PIXEL_OFFICE_MODE: R.mode, PIXEL_OFFICE_ROOT: R.mode === "project" ? R.base : R.root });
export function rootFromEnv(env: NodeJS.ProcessEnv = process.env): Root {
  if (env.PIXEL_OFFICE_MODE === "project" && env.PIXEL_OFFICE_ROOT) return projectRoot(env.PIXEL_OFFICE_ROOT);
  if (env.PIXEL_OFFICE_MODE === "global") return globalRoot();
  if (env.PIXEL_OFFICE_PROJECT) return projectRoot(env.PIXEL_OFFICE_PROJECT); // older launchers
  return resolveRoot();
}

const defaultsFor = (R: Root) => ({
  locale: "en",
  port: 4747,
  host: "127.0.0.1",
  employeesDir: R.mode === "project" ? `${CONFIG_DIR}/employees` : "employees",
  dataDir: R.mode === "project" ? `${CONFIG_DIR}/data` : "data",
  memoryFile: "memory.md",
  syncClaudeAgents: true,
  refreshHours: 24,
});

const slugId = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const configPath = (R: Root) => path.join(R.root, "config.json");

export type RawConfig = Record<string, unknown> & { offices?: Array<Record<string, unknown>> };

export function readRawConfig(R: Root): RawConfig {
  const file = configPath(R);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

export function writeRawConfig(R: Root, raw: RawConfig) {
  fs.mkdirSync(R.root, { recursive: true });
  fs.writeFileSync(configPath(R), JSON.stringify(raw, null, 2) + "\n");
}

export const expandHome = (p: string) => String(p).replace(/^~(?=$|[\\/])/, os.homedir());
export const absPath = (base: string, p: string) => path.resolve(base, expandHome(p));
// Display form: home folder shown as ~, otherwise absolute.
export const displayPath = (p: string) => { const h = os.homedir(); return p === h ? "~" : p.startsWith(h + path.sep) ? "~" + p.slice(h.length) : p; };
export const officeIdOf = (s: string, fallback: string) => slugId(s) || fallback;

// One office definition from its raw config entry.
export function officeDefFromRaw(R: Root, o: Record<string, unknown>, i: number, rootCwd: string): OfficeDef {
  const abs = (p: string) => absPath(R.base, p);
  const id = officeIdOf(String(o.id ?? o.name ?? `office-${i + 1}`), `office-${i + 1}`);
  const d = defaultsFor(R);
  return {
    id,
    name: String(o.name ?? id),
    employeesDir: abs(String(o.employeesDir ?? `${d.employeesDir}/${id}`)),
    cwd: o.cwd ? abs(String(o.cwd)) : rootCwd,
    extraEmployees: Array.isArray(o.employees) ? (o.employees as string[]).map(abs) : [],
    theme: (THEMES as readonly string[]).includes(String(o.theme)) ? (o.theme as Theme) : "default",
  };
}

export function loadSettings(R: Root): OfficeSettings {
  const raw = readRawConfig(R);
  const merged = { ...defaultsFor(R), ...raw } as Record<string, unknown>;
  const abs = (p: string) => absPath(R.base, p);
  const rootCwd = merged.cwd ? abs(String(merged.cwd)) : R.defaultCwd;
  const multiOffice = Array.isArray(raw.offices) && raw.offices.length > 0;
  const offices: OfficeDef[] = multiOffice
    ? (raw.offices as Array<Record<string, unknown>>).map((o, i) => officeDefFromRaw(R, o, i, rootCwd))
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
    sickness: merged.sickness !== false && process.env.PIXEL_OFFICE_SICKNESS !== "0",
    multiOffice,
    offices,
  };
}

// Creates config.json + employees/_template under the root. Project mode also git-ignores the data dir.
export function initRoot(R: Root, opts: { locale?: string; memoryInGit?: boolean } = {}) {
  const locale = opts.locale ?? "en";
  const d = defaultsFor(R);
  fs.mkdirSync(path.join(R.base, d.employeesDir), { recursive: true });
  const cfg = configPath(R);
  if (!fs.existsSync(cfg)) {
    const body: Record<string, unknown> = { locale, port: d.port, employeesDir: d.employeesDir, dataDir: d.dataDir, memoryFile: d.memoryFile, syncClaudeAgents: true, refreshHours: 24 };
    if (R.mode === "project") body.cwd = ".";
    writeRawConfig(R, body);
  }
  const tplSrc = path.join(PKG_ROOT, "templates", "employee", locale);
  const tplDst = path.join(R.base, d.employeesDir, "_template");
  if (!fs.existsSync(tplDst) && fs.existsSync(tplSrc)) fs.cpSync(tplSrc, tplDst, { recursive: true });
  if (R.mode === "project") {
    const gi = path.join(R.base, ".gitignore");
    const lines = [`${CONFIG_DIR}/data/`];
    if (opts.memoryInGit === false) lines.push(`${CONFIG_DIR}/employees/**/${d.memoryFile}`);
    const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
    const missing = lines.filter((l) => !existing.split(/\r?\n/).includes(l));
    if (missing.length) fs.writeFileSync(gi, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
  }
  return { configFile: cfg, employeesDir: path.join(R.base, d.employeesDir) };
}
