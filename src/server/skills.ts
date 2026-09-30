import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PKG_ROOT } from "./config.js";
import { skillDirOf, skillSourceOf } from "./agents.js";

// The Skill Market: ready-made skills (a folder with a SKILL.md, sometimes scripts and reference files) that companies and communities
// publish on GitHub, offered from a catalogue (catalog/skills.json, made by scripts/build-skill-catalog.mjs) and installed onto the
// employees the boss picks. Nothing is fetched until the boss installs or previews a skill, and what is fetched is exactly the files of the
// commit the catalogue names (never a branch), so a skill cannot change under the office after it was looked at.
//
// A skill is instructions plus, at worst, scripts an employee could run with Bash, so the market treats every one as untrusted code:
//  - a preview shows the SKILL.md and every script, with the risky patterns (network fetches piped to a shell, encoded payloads, secrets,
//    hidden characters) marked, before anything is installed;
//  - `allowed-tools` (a skill granting itself permissions) is removed from the installed copy: the boss's permission mode decides;
//  - nothing is ever run at install time; the files are only copied;
//  - a downloaded skill is kept once, read-only in spirit, under <dataDir>/skills-store/<id>@<sha>, and each employee gets a copy of it.
// The employee folder is a Claude Code plugin already, so Claude loads an installed skill by itself; Codex and Gemini get it through the
// skills index they are handed each turn (both read the same folder listing).

export interface SkillEntry {
  id: string; name: string; vendor: string; repo: string; sha: string; path: string; category: string;
  description: string; license: string; icon?: string; brand?: string; scripts: boolean; bytes: number; bodyChars: number;
  files: Array<[string, number]>;
}
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,80}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const LIMITS = { files: 400, bytes: 10 * 1024 * 1024, file: 5 * 1024 * 1024, preview: 24 * 1024 };

let cache: { categories: string[]; skills: SkillEntry[] } | undefined;
export const extraSkills: SkillEntry[] = []; // (a test adds its own)
function safeRel(p: unknown): p is string {
  return typeof p === "string" && !!p && p.length < 300 && !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && !p.split("/").some((s) => s === ".." || s === "." || s === "");
}
export function skillCatalog(): { categories: string[]; skills: SkillEntry[] } {
  if (!cache) {
    const skills: SkillEntry[] = [];
    let categories: string[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "catalog", "skills.json"), "utf8")) as { categories?: string[]; skills?: SkillEntry[] };
      categories = (raw.categories ?? []).filter((c) => typeof c === "string");
      for (const e of raw.skills ?? []) {
        const ok = e && ID_RE.test(String(e.id)) && NAME_RE.test(String(e.name)) && SHA_RE.test(String(e.sha)) && REPO_RE.test(String(e.repo)) && categories.includes(e.category)
          && typeof e.description === "string" && (e.path === "" || safeRel(e.path)) && Array.isArray(e.files) && e.files.length > 0 && e.files.length <= LIMITS.files
          && e.files.every((f) => Array.isArray(f) && safeRel(f[0]) && Number.isFinite(f[1]) && f[1] <= LIMITS.file) && e.files.some((f) => f[0] === "SKILL.md")
          && e.files.reduce((n, f) => n + f[1], 0) <= LIMITS.bytes && !skills.some((y) => y.id === e.id);
        if (ok) skills.push(e); else console.warn(`[pixel-office] skills: skipped a catalogue entry that is not valid (${String((e as { id?: unknown })?.id)})`);
      }
    } catch (err) { console.warn("[pixel-office] skills: could not read catalog/skills.json:", (err as Error).message); }
    cache = { categories, skills };
  }
  return { categories: cache.categories, skills: [...cache.skills, ...extraSkills] };
}
export const skillById = (id: string): SkillEntry | undefined => skillCatalog().skills.find((s) => s.id === id);

export interface SkillView { id: string; name: string; vendor: string; repo: string; sha: string; category: string; description: string; license: string; icon?: string; brand?: string; scripts: boolean; kb: number; files: number; bodyChars: number; url: string }
export const viewOfSkill = (e: SkillEntry): SkillView => ({
  id: e.id, name: e.name, vendor: e.vendor, repo: e.repo, sha: e.sha, category: e.category, description: e.description, license: e.license, icon: e.icon, brand: e.brand,
  scripts: e.scripts, kb: Math.round(e.bytes / 1024), files: e.files.length, bodyChars: e.bodyChars, url: `https://github.com/${e.repo}/tree/${e.sha}/${e.path}`.replace(/\/$/, ""),
});

let dataDir = "";
export function initSkills(dir: string) { dataDir = dir; }
const rawBase = () => (process.env.PO_SKILLS_RAW_BASE || "https://raw.githubusercontent.com").replace(/\/$/, "");
const rawUrl = (e: SkillEntry, rel: string) => `${rawBase()}/${e.repo}/${e.sha}/${e.path ? e.path + "/" : ""}${rel}`;

async function fetchFile(e: SkillEntry, rel: string, max: number): Promise<Buffer> {
  const res = await fetch(rawUrl(e, rel), { redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`download:${res.status} ${rel}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error(`download:too big ${rel}`);
  return buf;
}

// ---- what looks risky in a skill's files ----
export interface Flag { flag: string; file: string }
const PATTERNS: Array<[string, RegExp]> = [
  ["pipeToShell", /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i],
  ["download", /\b(curl|wget|Invoke-WebRequest|iwr)\b/i],
  ["eval", /\b(eval|exec)\s*\(|\bos\.system\b|child_process|subprocess\.(run|Popen|call)\b/],
  ["encoded", /base64\s+(-d|--decode)|atob\(|frombase64string|b64decode/i],
  ["destructive", /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)|\bmkfs\b|\bdd\s+if=|>\s*\/dev\/sd/i],
  ["privilege", /\bsudo\b|\bchmod\s+[0-7]*7[0-7]*\b|\bchown\b/],
  ["secrets", /\.ssh\b|\.aws\/credentials|\.npmrc|id_rsa|keychain|\/etc\/passwd|process\.env\b[^\n]{0,40}(KEY|TOKEN|SECRET)/i],
  ["hiddenChars", /[​-‏‪-‮⁠-⁤﻿]/],
  ["allowedTools", /^allowed-tools:/m],
];
export function scanText(text: string, file: string): Flag[] {
  const out: Flag[] = [];
  for (const [flag, re] of PATTERNS) if (re.test(text)) out.push({ flag, file });
  return out;
}
const isScript = (rel: string) => /(^|\/)scripts\//.test(rel) || /\.(py|sh|bash|js|mjs|cjs|ts|rb|ps1)$/i.test(rel);

export interface Preview { skill: SkillView; skillMd: string; files: Array<{ path: string; bytes: number; script: boolean }>; flags: Flag[]; scripts: Array<{ path: string; text: string; truncated: boolean }> }
// Looks at a skill without installing it: its SKILL.md, the file list, and the text of the scripts (the first few), all scanned.
export async function previewSkill(id: string): Promise<Preview> {
  const e = skillById(id);
  if (!e) throw new Error("unknown");
  const skillMd = (await fetchFile(e, "SKILL.md", LIMITS.file)).toString("utf8");
  const flags = scanText(skillMd, "SKILL.md");
  const scripts: Preview["scripts"] = [];
  for (const [rel, size] of e.files.filter(([r]) => isScript(r)).slice(0, 8)) {
    try {
      const buf = await fetchFile(e, rel, LIMITS.file);
      const text = buf.toString("utf8");
      flags.push(...scanText(text, rel));
      scripts.push({ path: rel, text: text.slice(0, LIMITS.preview), truncated: text.length > LIMITS.preview });
    } catch { scripts.push({ path: rel, text: "", truncated: size > 0 }); }
  }
  return { skill: viewOfSkill(e), skillMd: skillMd.slice(0, 60000), files: e.files.map(([p, b]) => ({ path: p, bytes: b, script: isScript(p) })), flags, scripts };
}

// ---- the store, and copying into an employee ----
const storeDir = (e: SkillEntry) => path.join(dataDir, "skills-store", `${e.id}@${e.sha.slice(0, 10)}`);
// SKILL.md without the frontmatter line that lets a skill approve its own tools
export function stripAllowedTools(md: string): { text: string; stripped: boolean } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return { text: md, stripped: false };
  const lines = m[1].split(/\r?\n/);
  const out: string[] = [];
  let skipping = false, stripped = false;
  for (const line of lines) {
    if (/^allowed-tools\s*:/.test(line)) { skipping = true; stripped = true; continue; }
    if (skipping && /^\s+\S|^\s*-\s/.test(line)) continue;
    skipping = false;
    out.push(line);
  }
  return stripped ? { text: `---\n${out.join("\n")}\n---${md.slice(m[0].length)}`, stripped } : { text: md, stripped };
}

// Downloads the pinned files into the store (once), checking the count and sizes the catalogue promised.
async function ensureStored(e: SkillEntry): Promise<string> {
  if (!dataDir) throw new Error("not ready");
  const dest = storeDir(e);
  if (fs.existsSync(path.join(dest, ".complete"))) return dest;
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const hash = crypto.createHash("sha256");
    let total = 0, strippedTools = false;
    for (const [rel, size] of e.files) {
      const to = path.join(tmp, rel);
      if (path.relative(tmp, to).startsWith("..")) throw new Error("bad path");
      let buf = await fetchFile(e, rel, Math.min(LIMITS.file, size + 1024));
      total += buf.length;
      if (total > LIMITS.bytes) throw new Error("download:too big");
      if (rel === "SKILL.md") { const r = stripAllowedTools(buf.toString("utf8")); strippedTools = r.stripped; buf = Buffer.from(r.text); }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, buf);
      hash.update(rel).update(buf);
    }
    fs.writeFileSync(path.join(tmp, ".po-skill.json"), JSON.stringify({ id: e.id, sha: e.sha, vendor: e.vendor, repo: e.repo, hash: hash.digest("hex"), strippedAllowedTools: strippedTools, installedAt: Date.now() }, null, 1));
    fs.writeFileSync(path.join(tmp, ".complete"), "");
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    return dest;
  } catch (err) { fs.rmSync(tmp, { recursive: true, force: true }); throw err; }
}

export type InstallResult = "installed" | "already" | "conflict";
// Copies a skill into one employee's skills folder. A folder of the same name that is not this market skill is never overwritten.
export async function installSkill(pluginDir: string, id: string): Promise<InstallResult> {
  const e = skillById(id);
  if (!e) throw new Error("unknown");
  const target = skillDirOf(pluginDir, e.name);
  if (!target) throw new Error("bad name");
  const cur = fs.existsSync(target) ? skillSourceOf(target) : undefined;
  if (fs.existsSync(target) && cur?.id !== id) return "conflict";
  if (cur?.sha === e.sha) return "already";
  const store = await ensureStored(e);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(store, tmp, { recursive: true, filter: (src) => path.basename(src) !== ".complete" });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(tmp, target);
  return "installed";
}
// Removes a market skill from an employee (never one the boss wrote or an unrelated folder).
export function uninstallSkill(pluginDir: string, id: string): boolean {
  const e = skillById(id);
  const target = e && skillDirOf(pluginDir, e.name);
  if (!target || skillSourceOf(target)?.id !== id) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}
// Which market skills an employee has (by id).
export function installedIds(pluginDir: string | undefined): string[] {
  if (!pluginDir) return [];
  const base = path.join(pluginDir, "skills");
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  for (const n of fs.readdirSync(base)) { const s = skillSourceOf(path.join(base, n)); if (s) out.push(s.id); }
  return out;
}
