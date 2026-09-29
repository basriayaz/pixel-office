import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { readRawConfig, writeRawConfig, type Root } from "./config.js";
import { readJsonSafe } from "./fsutil.js";
import { codexModels } from "./codex.js";

// The LLM providers an employee can run on, managed from Settings → Models. Each one is "active" when the boss has it switched
// on AND it is connected (installed and signed in, or an API key is there); only active providers' models can be given to an
// employee. How each one runs:
//   claude      the Claude Agent SDK (Claude Code), signed in with the plan or ANTHROPIC_API_KEY
//   codex       the Codex CLI, one process per turn (codex.ts)
//   gemini      the Gemini CLI, one process per turn (gemini.ts), with a Gemini API key
//   openrouter  the Claude Agent SDK pointed at OpenRouter's Anthropic-compatible endpoint: any model OpenRouter serves, with
//               the same tools, permissions and sessions as a Claude employee
// On/off switches and model lists live in config.json (`providers`); API keys in <dataDir>/secrets.json (0600), which is
// never in git, not even in project mode, where config.json is.

export const PROVIDERS = ["claude", "codex", "gemini", "openrouter"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export type Engine = ProviderId;

export interface ModelEntry { id: string; name: string; desc: string; provider: ProviderId }
export interface ProviderStatus {
  id: ProviderId;
  enabled: boolean;
  connected: boolean;
  installed: boolean;    // for the CLIs; true for OpenRouter (nothing to install)
  version: string;
  detail: string;        // one line: how it is signed in, or what is missing
  warning?: string;      // connected but something is off (e.g. an invalid CLI config file)
  keyHint?: string;      // "…abcd" when a key is stored here; "env" when it comes from the environment
  models: ModelEntry[];  // what it offers (all of them, active or not)
  custom: string[];      // model ids the boss added by hand
}

// Claude models the office offers (Claude Code takes these ids as they are).
export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6"] as const;
// What the Gemini CLI knows by name (gemini-cli-core config/models.js); the boss can add others.
const GEMINI_MODELS: Array<[string, string]> = [
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro (preview)"],
  ["gemini-3-flash-preview", "Gemini 3 Flash (preview)"],
  ["gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite (preview)"],
  ["gemini-2.5-pro", "Gemini 2.5 Pro"],
  ["gemini-2.5-flash", "Gemini 2.5 Flash"],
  ["gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite"],
];
export const OPENROUTER_PREFIX = "openrouter:";
export const OPENROUTER_BASE = "https://openrouter.ai/api";

// Which engine a model id belongs to. OpenRouter ids carry a prefix ("openrouter:openai/gpt-5"), Gemini ids start with
// "gemini-", Codex ids come from the Codex account (or look like one); everything else is Claude.
export function engineOf(model?: string): Engine {
  if (!model) return "claude";
  if (model.startsWith(OPENROUTER_PREFIX)) return "openrouter";
  if (/^gemini-/.test(model)) return "gemini";
  if (codexModels().some((m) => m.id === model) || /^(gpt-|codex-)/.test(model)) return "codex";
  return "claude";
}
export const openrouterSlug = (model: string) => model.slice(OPENROUTER_PREFIX.length);

// ---- stored state ----
let R: Root;
let secretsFile = "";
interface ProviderCfg { enabled?: boolean; models?: string[] }
type Secrets = Partial<Record<ProviderId, { apiKey?: string }>>;

// Everything is probed once at start, so the first page load already knows (Codex's model list comes with it).
export let providersReady: Promise<void> = Promise.resolve();
export function initProviders(root: Root, dataDir: string) {
  R = root;
  secretsFile = path.join(dataDir, "secrets.json");
  providersReady = Promise.all(PROVIDERS.map((id) => probe(id))).then(() => undefined);
  // saved OpenRouter models show their names, not only their slugs
  if (cfgOf("openrouter").models?.length) void openrouterCatalog().catch(() => {});
}
function cfgOf(id: ProviderId): ProviderCfg {
  const all = (readRawConfig(R).providers ?? {}) as Record<string, ProviderCfg>;
  return all[id] ?? {};
}
function saveCfg(id: ProviderId, next: ProviderCfg) {
  const raw = readRawConfig(R);
  const all = { ...((raw.providers ?? {}) as Record<string, ProviderCfg>) };
  all[id] = { ...all[id], ...next };
  raw.providers = all;
  writeRawConfig(R, raw);
}
const readSecrets = (): Secrets => readJsonSafe<Secrets>(secretsFile, () => ({}));
function saveSecret(id: ProviderId, apiKey: string | undefined) {
  const s = readSecrets();
  if (apiKey) s[id] = { ...s[id], apiKey }; else delete s[id];
  // owner-only from the first byte, and no .bak copy of old keys lying around
  fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
  const tmp = `${secretsFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, secretsFile);
}
// The key to use: the one saved in the panel, else the environment's.
const ENV_KEYS: Partial<Record<ProviderId, string[]>> = { gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], openrouter: ["OPENROUTER_API_KEY"] };
function keyOf(id: ProviderId): { key?: string; from?: "saved" | "env" } {
  const saved = readSecrets()[id]?.apiKey;
  if (saved) return { key: saved, from: "saved" };
  for (const v of ENV_KEYS[id] ?? []) if (process.env[v]) return { key: process.env[v], from: "env" };
  return {};
}
const hint = (k: { key?: string; from?: "saved" | "env" }) => (!k.key ? undefined : k.from === "env" ? "env" : `…${k.key.slice(-4)}`);
// Switched on unless the boss turned it off (a provider that is not connected offers nothing either way).
const enabledOf = (id: ProviderId) => cfgOf(id).enabled ?? true;

// ---- status: local commands and one HTTP call, no model calls; cached and refreshed in the background ----
const run = (cmd: string, args: string[], timeout = 8000) => new Promise<{ ok: boolean; out: string }>((resolve) => {
  execFile(cmd, args, { timeout, encoding: "utf8" }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout ?? ""}${stderr ?? ""}`.trim() }));
});

type Probe = Omit<ProviderStatus, "id" | "enabled" | "models" | "custom" | "keyHint">;
async function probeClaude(): Promise<Probe> {
  const v = await run("claude", ["--version"]);
  if (!v.ok) return process.env.ANTHROPIC_API_KEY
    ? { connected: true, installed: false, version: "", detail: "ANTHROPIC_API_KEY" }
    : { connected: false, installed: false, version: "", detail: "missing" };
  const version = v.out.split("\n")[0].replace(/\s*\(Claude Code\)\s*$/i, "");
  const s = await run("claude", ["auth", "status"]);
  let j: { loggedIn?: boolean; authMethod?: string } = {};
  try { j = JSON.parse(s.out); } catch {}
  if (j.loggedIn) return { connected: true, installed: true, version, detail: j.authMethod ?? "signed in" };
  if (process.env.ANTHROPIC_API_KEY) return { connected: true, installed: true, version, detail: "ANTHROPIC_API_KEY" };
  return { connected: false, installed: true, version, detail: "signedOut" };
}
// `codex login status` only reads the sign-in file: it says "Logged in" for a session whose refresh token died months ago. So the
// file is looked at too (the access token's expiry), and a token that is past it is tried once with a real (tiny) turn, which is
// when Codex refreshes it, or fails with the 401. The verdict is kept per version of the file, so a new sign-in is tried again.
const codexAuthFile = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");
function codexAuthInfo(): { mtime: number; stale: boolean } | null {
  try {
    const file = codexAuthFile();
    const mtime = fs.statSync(file).mtimeMs;
    const a = JSON.parse(fs.readFileSync(file, "utf8")) as { auth_mode?: string; tokens?: { access_token?: string } };
    if (a.auth_mode !== "chatgpt") return { mtime, stale: false }; // an API key does not expire that way
    const exp = JSON.parse(Buffer.from(String(a.tokens?.access_token).split(".")[1], "base64url").toString()).exp;
    return { mtime, stale: typeof exp === "number" && exp * 1000 < Date.now() };
  } catch { return null; }
}
export const AUTH_ERROR = /unauthorized|\b401\b|refresh token|sign in again|log ?in again|invalid_refresh_token|invalid api key|api key not valid|API_KEY_INVALID|\b403\b/i;
// what a failed turn taught us: this sign-in (codex: the auth file as it was; gemini: that key) does not work
const authFailed = new Map<ProviderId, string>();
const fingerprint = (id: ProviderId) => (id === "codex" ? String(codexAuthInfo()?.mtime ?? "") : id === "gemini" ? keyOf("gemini").key ?? "" : "");
export function markAuthFailed(id: ProviderId) {
  authFailed.set(id, fingerprint(id));
  const c = probed.get(id);
  if (c) probed.set(id, { at: Date.now(), value: { ...c.value, connected: false, detail: "authExpired" } });
}
let codexHealth: { mtime: number; ok?: boolean; pending?: Promise<void> } | null = null;
function codexHealthCheck(mtime: number): Promise<void> {
  const state: NonNullable<typeof codexHealth> = { mtime };
  state.pending = new Promise<void>((resolve) => {
    const child = execFile("codex", ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-s", "read-only", "-C", os.tmpdir(), "reply with ok"], { timeout: 60000, encoding: "utf8", cwd: os.tmpdir() }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ?? ""}`;
      state.ok = !err && !/Failed to refresh token/i.test(out) && !/"type":"(turn\.failed|error)"/.test(stdout ?? "");
      if (!state.ok && !AUTH_ERROR.test(out) && err) state.ok = true; // failed for another reason (offline, ...): not proof that the sign-in is bad
      state.pending = undefined;
      // the answer arrives after the probe returned: the snapshot is corrected here
      if (!state.ok) markAuthFailed("codex");
      resolve();
    });
    child.stdin?.end(); // codex waits for extra input on stdin otherwise
  });
  codexHealth = state;
  return state.pending;
}
async function probeCodex(fresh = false): Promise<Probe> {
  const v = await run("codex", ["--version"]);
  if (!v.ok) return { connected: false, installed: false, version: "", detail: "missing" };
  const s = await run("codex", ["login", "status"]);
  const version = v.out.split("\n")[0].replace(/^codex(-cli)?\s*/i, "");
  let loggedIn = s.ok && !/not logged in/i.test(s.out);
  let detail = loggedIn ? s.out.split("\n")[0].slice(0, 120) : "signedOut";
  if (loggedIn) {
    const info = codexAuthInfo();
    if (authFailed.has("codex") && authFailed.get("codex") === fingerprint("codex")) { loggedIn = false; detail = "authExpired"; }
    else if (info?.stale) {
      if (!codexHealth || codexHealth.mtime !== info.mtime) { const p = codexHealthCheck(info.mtime); if (fresh) await p; }
      else if (fresh && codexHealth.pending) await codexHealth.pending;
      if (authFailed.get("codex") === fingerprint("codex") && codexHealth?.ok === false) { loggedIn = false; detail = "authExpired"; }
    }
  }
  if (loggedIn) codexModels(true);
  return { connected: loggedIn, installed: true, version, detail };
}
async function probeGemini(): Promise<Probe> {
  const v = await run("gemini", ["--version"], 15000);
  if (!v.ok) return { connected: false, installed: false, version: "", detail: "missing" };
  const lines = v.out.split("\n").map((l) => l.trim()).filter(Boolean);
  const version = lines.filter((l) => /^\d+\.\d+/.test(l)).pop() ?? "";
  // the CLI reads ~/.gemini/settings.json on every start and prints what it could not understand
  const bad = v.out.match(/Invalid configuration in (\S+)/);
  const warning = bad ? `invalidConfig:${bad[1].replace(/:$/, "")}` : undefined;
  // a personal Google sign-in is refused for this client ("no longer supported for Gemini Code Assist for individuals"):
  // an API key is what makes it work
  const k = keyOf("gemini");
  const rejected = !!k.key && authFailed.get("gemini") === k.key;
  return { connected: !!k.key && !rejected, installed: true, version, detail: !k.key ? "needKey" : rejected ? "badKey" : "apiKey", ...(warning ? { warning } : {}) };
}
async function probeOpenRouter(): Promise<Probe> {
  const k = keyOf("openrouter");
  if (!k.key) return { connected: false, installed: true, version: "", detail: "needKey" };
  try {
    const r = await fetch(`${OPENROUTER_BASE}/v1/key`, { headers: { Authorization: `Bearer ${k.key}` }, signal: AbortSignal.timeout(10000) });
    if (r.status === 401 || r.status === 403) return { connected: false, installed: true, version: "", detail: "badKey" };
    if (!r.ok) return { connected: false, installed: true, version: "", detail: `http:${r.status}` };
    const j = (await r.json().catch(() => ({}))) as { data?: { label?: string; usage?: number; limit?: number | null } };
    const d = j.data ?? {};
    const usage = typeof d.usage === "number" ? `$${d.usage.toFixed(2)}${typeof d.limit === "number" ? ` / $${d.limit.toFixed(2)}` : ""}` : "";
    return { connected: true, installed: true, version: "", detail: ["apiKey", usage].filter(Boolean).join(" · ") };
  } catch (err) {
    return { connected: false, installed: true, version: "", detail: `offline:${(err as Error).message.slice(0, 80)}` };
  }
}
const PROBES: Record<ProviderId, (fresh: boolean) => Promise<Probe>> = { claude: probeClaude, codex: probeCodex, gemini: probeGemini, openrouter: probeOpenRouter };

const probed = new Map<ProviderId, { at: number; value: Probe }>();
const inflight = new Map<ProviderId, Promise<Probe>>();
async function probe(id: ProviderId, fresh = false): Promise<Probe> {
  const c = probed.get(id);
  if (c && !fresh && Date.now() - c.at < 60e3) return c.value;
  let p = inflight.get(id);
  if (!p) {
    p = PROBES[id](fresh).catch((err): Probe => ({ connected: false, installed: false, version: "", detail: `error:${(err as Error).message}` }))
      .then((value) => { probed.set(id, { at: Date.now(), value }); inflight.delete(id); return value; });
    inflight.set(id, p);
  }
  return p;
}

// ---- models ----
function modelsOf(id: ProviderId): ModelEntry[] {
  const custom = cfgOf(id).models ?? [];
  if (id === "claude") return [...CLAUDE_MODELS].map((m) => ({ id: m, name: m, desc: "", provider: id }));
  if (id === "codex") return codexModels().map((m) => ({ id: m.id, name: m.name, desc: m.desc, provider: id }));
  if (id === "gemini") {
    const known = new Set(GEMINI_MODELS.map(([m]) => m));
    return [...GEMINI_MODELS.map(([m, name]) => ({ id: m, name, desc: "", provider: id })), ...custom.filter((m) => !known.has(m)).map((m) => ({ id: m, name: m, desc: "", provider: id }))];
  }
  return custom.map((slug) => ({ id: OPENROUTER_PREFIX + slug, name: orNames.get(slug) ?? slug, desc: slug, provider: id }));
}

// Active = switched on and connected, as last probed. The snapshot is synchronous: pages and validation read it.
export function isActive(id: ProviderId) {
  const p = probed.get(id)?.value;
  return enabledOf(id) && !!p?.connected;
}
export function activeModels(): ModelEntry[] { return PROVIDERS.filter(isActive).flatMap(modelsOf); }
export const isActiveModel = (model: string) => activeModels().some((m) => m.id === model);

export async function providerStatuses(fresh = false): Promise<ProviderStatus[]> {
  return Promise.all(PROVIDERS.map(async (id) => {
    const p = await probe(id, fresh);
    return { id, enabled: enabledOf(id), ...p, keyHint: hint(keyOf(id)), models: modelsOf(id), custom: cfgOf(id).models ?? [] };
  }));
}

// A change from the panel. The key is checked (probed) right away; an empty string removes a saved key.
export async function updateProvider(id: ProviderId, b: { enabled?: boolean; apiKey?: string; models?: string[] }) {
  const next: ProviderCfg = {};
  if (b.enabled !== undefined) next.enabled = b.enabled;
  if (b.models !== undefined) next.models = [...new Set(b.models.map((m) => m.trim()).filter(Boolean))].slice(0, 100);
  if (Object.keys(next).length) saveCfg(id, next);
  if (b.apiKey !== undefined && (id === "gemini" || id === "openrouter")) saveSecret(id, b.apiKey.trim() || undefined);
  await probe(id, true);
}

// ---- what an engine needs at run time ----
export const geminiKey = () => keyOf("gemini").key;
// Claude Code pointed at OpenRouter: every model tier maps to the chosen model, so nothing asks OpenRouter for a Claude id it
// does not know; no Anthropic key may leak into the request.
export function openrouterEnv(model: string): Record<string, string> {
  const slug = openrouterSlug(model);
  return {
    ANTHROPIC_BASE_URL: OPENROUTER_BASE,
    ANTHROPIC_AUTH_TOKEN: keyOf("openrouter").key ?? "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: slug,
    ANTHROPIC_DEFAULT_OPUS_MODEL: slug,
    ANTHROPIC_DEFAULT_SONNET_MODEL: slug,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: slug,
    ANTHROPIC_SMALL_FAST_MODEL: slug,
    CLAUDE_CODE_SUBAGENT_MODEL: slug,
  };
}

// OpenRouter's public model list, for the "add a model" search in the panel. Cached for an hour.
export interface OrModel { id: string; name: string; context: number; prompt: number; completion: number; tools: boolean }
let orCatalog: { at: number; list: OrModel[] } | null = null;
const orNames = new Map<string, string>();
export async function openrouterCatalog(): Promise<OrModel[]> {
  if (orCatalog && Date.now() - orCatalog.at < 3600e3) return orCatalog.list;
  const r = await fetch(`${OPENROUTER_BASE}/v1/models`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`OpenRouter: HTTP ${r.status}`);
  const j = (await r.json()) as { data?: Array<Record<string, unknown>> };
  const list = (j.data ?? []).map((m) => {
    const pricing = (m.pricing ?? {}) as Record<string, string>;
    const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as string[]) : [];
    return { id: String(m.id), name: String(m.name ?? m.id), context: Number(m.context_length) || 0, prompt: Number(pricing.prompt) || 0, completion: Number(pricing.completion) || 0, tools: params.includes("tools") };
  });
  for (const m of list) orNames.set(m.id, m.name);
  orCatalog = { at: Date.now(), list };
  return list;
}

// ---- install and sign-in from the panel ----
// The CLIs are npm packages; nothing else is ever installed from here.
const PACKAGES: Partial<Record<ProviderId, string>> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", gemini: "@google/gemini-cli" };
export const canInstall = (id: ProviderId) => !!PACKAGES[id];
export async function installProvider(id: ProviderId): Promise<{ ok: boolean; output: string }> {
  const pkg = PACKAGES[id];
  if (!pkg) return { ok: false, output: "nothing to install" };
  const r = await new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile("npm", ["install", "-g", pkg], { timeout: 5 * 60e3, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout ?? ""}${stderr ?? ""}`.trim().slice(-1500) }));
  });
  await probe(id, true);
  return { ok: r.ok, output: r.out };
}
// Sign-in opens the CLI's own browser flow on this machine; the panel checks the status again afterwards.
const LOGIN: Partial<Record<ProviderId, string[]>> = { claude: ["claude", "auth", "login"], codex: ["codex", "login"] };
export const canLogin = (id: ProviderId) => !!LOGIN[id];
export function loginProvider(id: ProviderId): boolean {
  const cmd = LOGIN[id];
  if (!cmd) return false;
  try {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch { return false; }
}
export const refreshProvider = (id: ProviderId) => probe(id, true);
