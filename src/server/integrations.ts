import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { PKG_ROOT } from "./config.js";
import { isObject as isObj, readJsonSafe } from "./fsutil.js";
const isObject = (v: unknown): v is Record<string, any> => isObj(v); // eslint-disable-line @typescript-eslint/no-explicit-any

// Integrations: the market of MCP servers the boss can add (a catalogue in catalog/integrations.json, plus servers of their own) and give
// to individual employees. Three ways in, whatever the service offers: sign in with the account (OAuth, done here with the MCP SDK's
// own flow: discovery, dynamic client registration, PKCE, refresh), paste a key / token, or nothing at all (open servers).
//
// The employees never see a credential. Their sessions connect to a local gateway (/gw/<employee>/<integration>, see `gateway`) that
// adds the current one itself: an OAuth token lives an hour, a session lives longer, and a key that never enters a session process cannot
// leak from it. The gateway is also where "this employee may use it" and "read-only" are enforced, on the server, not just asked nicely.
//
// Where things live: <dataDir>/integrations.json (owner-only, never in git): what was added and how, the credentials, the tools each
// server reported at the last check (so read-only tools, by their MCP `readOnlyHint`, need no question and the rest ask first), and the
// servers the boss defined themselves. The browser only ever gets "…abcd" hints. Who gets what is per employee (`integrations:` in agent.md).

export interface TokenSpec { help?: string; hint?: string; header?: string; prefix?: string; optional?: boolean }
export interface CatalogEntry {
  id: string;                                // also the MCP server name: tools are mcp__<id>__<tool>
  name: string;
  category: string;
  url: string;
  desc: { en: string; tr?: string };
  icon?: string;                             // web/logos/int/<icon>.svg (Simple Icons, drawn in the brand colour) or a file name with extension (a full-colour picture); without one the market draws a monogram
  brand?: string;                            // its colour
  oauth?: boolean;                           // "sign in with your account" works (the server supports dynamic client registration)
  ownClient?: string;                        // ...unless the service does not register clients itself (Google): the boss makes one OAuth client with the service and pastes it once; this names the group that shares it
  scopes?: string;                           // what to ask the account for (space-separated), when the server's own list is too broad
  token?: TokenSpec;                         // a key / token can be pasted (optional = it also works without)
  open?: boolean;                            // works with no sign-in at all
  readOnly?: { url?: string; query?: Record<string, string> }; // how to ask the server for its read-only variant
  readsOnly?: boolean;                       // everything it offers only reads (a documentation search): its tools need no question even without a readOnlyHint
  beta?: boolean;                            // token access is not documented by the service: "Check" tells whether it works
  featured?: boolean;                        // shown on the market's front shelf
  custom?: boolean;                          // defined by the boss, not in the catalogue
}
export type Method = "oauth" | "token" | "open";

const ID_RE = /^[a-z][a-z0-9_]{1,30}$/;
const ICON_RE = /^[a-z0-9_]{2,30}(\.(png|svg))?$/; // "name" = a one-colour mark (drawn in the brand colour); "name.png" / "name.svg" = the full-colour picture as it is
let builtIn: CatalogEntry[] | undefined;
let categories: string[] = [];
function loadCatalog(): CatalogEntry[] {
  if (builtIn) return builtIn;
  const out: CatalogEntry[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "catalog", "integrations.json"), "utf8")) as { categories?: string[]; integrations?: unknown[] };
    categories = (raw.categories ?? []).filter((c) => typeof c === "string");
    for (const x of raw.integrations ?? []) {
      const e = x as CatalogEntry;
      const ok = isObject(e) && ID_RE.test(String(e.id)) && typeof e.name === "string" && categories.includes(e.category) && /^https:\/\//.test(String(e.url)) && isObject(e.desc) && typeof e.desc.en === "string"
        && (e.oauth || e.token || e.open) && !out.some((y) => y.id === e.id) && (e.icon === undefined || ICON_RE.test(e.icon));
      if (ok) out.push(e); else console.warn(`[pixel-office] integrations: skipped a catalogue entry that is not valid (${isObject(x) ? String((x as { id?: unknown }).id) : "?"})`);
    }
  } catch (err) { console.warn("[pixel-office] integrations: could not read catalog/integrations.json:", (err as Error).message); }
  return (builtIn = out);
}
export const CATEGORIES = (): string[] => { loadCatalog(); return [...categories, "custom"]; };
// (a test adds its own entries here; nothing else does)
export const extraCatalog: CatalogEntry[] = [];
// the catalogue, the boss's own servers, and the test's
const allEntries = (): CatalogEntry[] => [...loadCatalog(), ...Object.entries(read().custom).map(([id, c]) => customEntry(id, c)), ...extraCatalog];
export const entryOf = (id: string): CatalogEntry | undefined => allEntries().find((e) => e.id === id);
const lookup = entryOf;

export interface ToolInfo { name: string; readOnly: boolean; desc: string }
interface OAuthStored { redirectUrl: string; clientInfo?: OAuthClientInformationMixed; tokens?: OAuthTokens; savedAt?: number }
interface Stored { added?: boolean; method?: Method; token?: string; oauth?: OAuthStored; readOnly?: boolean; tools?: ToolInfo[]; checkedAt?: number; ok?: boolean; error?: string }
interface CustomDef { name: string; url: string; oauth?: boolean; token?: TokenSpec; desc?: string }
interface OwnClient { id: string; secret?: string }
interface File { v: 1; items: Record<string, Stored>; custom: Record<string, CustomDef>; clients: Record<string, OwnClient> }

let file = "";
export function initIntegrations(dataDir: string) { file = path.join(dataDir, "integrations.json"); }

function customEntry(id: string, c: CustomDef): CatalogEntry {
  return { id, name: c.name, category: "custom", url: c.url, desc: { en: c.desc || new URL(c.url).host }, oauth: c.oauth, token: c.token, open: (!c.oauth && !c.token) || undefined, custom: true };
}
const cleanTokens = (t: unknown): OAuthTokens | undefined => (isObject(t) && typeof (t as OAuthTokens).access_token === "string" ? (t as OAuthTokens) : undefined);
function safeUrl(u: unknown): boolean {
  try { const x = new URL(String(u)); return x.protocol === "https:" || (x.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(x.hostname)); } catch { return false; }
}
function read(): File {
  const raw = file ? readJsonSafe<Partial<File>>(file, () => ({}), { validate: isObject, label: "integrations" }) : {};
  const custom: Record<string, CustomDef> = {};
  for (const [id, v] of Object.entries(isObject(raw.custom) ? (raw.custom as Record<string, unknown>) : {})) {
    const c = v as CustomDef;
    if (!/^custom_[a-z0-9_]{1,24}$/.test(id) || !isObject(c) || typeof c.name !== "string" || !safeUrl(c.url)) continue;
    const tk = isObject(c.token) ? (c.token as TokenSpec) : undefined;
    custom[id] = { name: c.name.slice(0, 60), url: c.url, oauth: c.oauth === true || undefined, token: tk ? { header: typeof tk.header === "string" ? tk.header.slice(0, 60) : undefined, prefix: typeof tk.prefix === "string" ? tk.prefix.slice(0, 20) : undefined, optional: tk.optional === true || undefined } : undefined, desc: typeof c.desc === "string" ? c.desc.slice(0, 200) : undefined };
  }
  const clients: Record<string, OwnClient> = {};
  for (const [g, v] of Object.entries(isObject(raw.clients) ? (raw.clients as Record<string, unknown>) : {})) {
    const c = v as OwnClient;
    if (/^[a-z][a-z0-9_]{1,20}$/.test(g) && isObject(c) && typeof c.id === "string" && c.id) clients[g] = { id: c.id.slice(0, 300), secret: typeof c.secret === "string" && c.secret ? c.secret.slice(0, 300) : undefined };
  }
  const known = new Set([...loadCatalog().map((e) => e.id), ...Object.keys(custom), ...extraCatalog.map((e) => e.id)]);
  const items: Record<string, Stored> = {};
  for (const [id, v] of Object.entries(isObject(raw.items) ? (raw.items as Record<string, unknown>) : {})) {
    if (!known.has(id) || !isObject(v)) continue;
    const s = v as Stored, o = isObject(s.oauth) ? (s.oauth as OAuthStored) : undefined;
    items[id] = {
      added: s.added === true, method: s.method === "oauth" || s.method === "token" || s.method === "open" ? s.method : undefined,
      token: typeof s.token === "string" && s.token ? s.token : undefined,
      oauth: o && typeof o.redirectUrl === "string" ? { redirectUrl: o.redirectUrl, clientInfo: isObject(o.clientInfo) ? (o.clientInfo as OAuthClientInformationMixed) : undefined, tokens: cleanTokens(o.tokens), savedAt: typeof o.savedAt === "number" ? o.savedAt : undefined } : undefined,
      readOnly: s.readOnly === true,
      tools: Array.isArray(s.tools) ? s.tools.filter((x) => isObject(x) && typeof x.name === "string").map((x) => ({ name: String(x.name).slice(0, 120), readOnly: x.readOnly === true, desc: String(x.desc ?? "").slice(0, 200) })).slice(0, 400) : undefined,
      checkedAt: typeof s.checkedAt === "number" ? s.checkedAt : undefined, ok: typeof s.ok === "boolean" ? s.ok : undefined, error: typeof s.error === "string" ? s.error.slice(0, 300) : undefined,
    };
  }
  return { v: 1, items, custom, clients };
}
function write(f: File) {
  if (!file) return;
  // owner-only from the first byte, and no .bak copy of old credentials lying around
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function update(id: string, fn: (s: Stored) => Stored): Stored {
  const f = read();
  f.items[id] = fn(f.items[id] ?? {});
  write(f);
  return f.items[id];
}
const hint = (t?: string) => (t ? `…${t.slice(-4)}` : undefined);

// ---- how a session / the gateway talks to a server ----
export function urlOf(e: CatalogEntry, readOnly: boolean): string {
  const ro = readOnly ? e.readOnly : undefined;
  const u = new URL(ro?.url ?? e.url);
  for (const [k, v] of Object.entries(ro?.query ?? {})) u.searchParams.set(k, v);
  return u.toString();
}
function tokenHeaders(e: CatalogEntry, token?: string): Record<string, string> {
  if (!token) return {};
  const h = e.token?.header ?? "Authorization";
  return { [h]: `${e.token?.prefix ?? (h === "Authorization" ? "Bearer " : "")}${token}` };
}
function withTimeout<T>(p: Promise<T>, ms = 15000): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), ms); })]).finally(() => clearTimeout(timer));
}

// ---- OAuth: sign in with the account ----
// A flow is pending from "Connect" until the service sends the browser back to /api/integrations/oauth/callback with a code.
interface Flow { id: string; state: string; redirectUrl: string; verifier?: string; authUrl?: URL; at: number }
const flows = new Map<string, Flow>();
const FLOW_TTL_MS = 10 * 60e3;
const oauthClientMeta = (redirectUrl: string): OAuthClientMetadata => ({ client_name: "Pixel Office (local)", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });

class Provider implements OAuthClientProvider {
  constructor(private id: string, private redirect: string, private flow?: Flow) {}
  private own() { const g = lookup(this.id)?.ownClient; return g ? read().clients[g] : undefined; }
  get redirectUrl() { return this.redirect; }
  get clientMetadata() { return oauthClientMeta(this.redirect); }
  state() { return this.flow?.state ?? crypto.randomBytes(24).toString("hex"); }
  clientInformation() { const own = this.own(); if (own) return { client_id: own.id, ...(own.secret ? { client_secret: own.secret } : {}) } as OAuthClientInformationMixed; const o = read().items[this.id]?.oauth; return o && o.redirectUrl === this.redirect ? o.clientInfo : undefined; } // (registered for another address, e.g. another port: register again)
  saveClientInformation(i: OAuthClientInformationMixed) { if (this.own()) return; update(this.id, (s) => ({ ...s, oauth: { ...(s.oauth?.redirectUrl === this.redirect ? s.oauth : {}), redirectUrl: this.redirect, clientInfo: i } })); }
  tokens() { const o = read().items[this.id]?.oauth; return o && o.redirectUrl === this.redirect ? o.tokens : undefined; }
  saveTokens(t: OAuthTokens) { update(this.id, (s) => ({ ...s, oauth: { ...s.oauth, redirectUrl: this.redirect, tokens: { ...t, refresh_token: t.refresh_token ?? s.oauth?.tokens?.refresh_token }, savedAt: Date.now() } })); }
  redirectToAuthorization(url: URL) {
    const e = lookup(this.id);
    if (e?.scopes) url.searchParams.set("scope", e.scopes);
    if (e?.ownClient === "google") { url.searchParams.set("access_type", "offline"); url.searchParams.set("prompt", "consent"); } // (without these Google gives no refresh token)
    if (this.flow) this.flow.authUrl = url;
  }
  saveCodeVerifier(v: string) { if (this.flow) this.flow.verifier = v; }
  codeVerifier() { return this.flow?.verifier ?? ""; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") update(this.id, (s) => ({ ...s, oauth: s.oauth ? { ...s.oauth, clientInfo: undefined, tokens: undefined } : undefined }));
    else if (scope === "tokens") update(this.id, (s) => ({ ...s, oauth: s.oauth ? { ...s.oauth, tokens: undefined } : undefined }));
  }
}
const sweepFlows = () => { for (const [k, f] of flows) if (Date.now() - f.at > FLOW_TTL_MS) flows.delete(k); };

// "Connect": returns where to send the browser (the service's sign-in page).
export async function startOAuth(id: string, origin: string): Promise<{ url: string }> {
  const e = lookup(id);
  if (!e?.oauth) throw new Error("noOauth");
  if (e.ownClient && !read().clients[e.ownClient]) throw new Error("noClient");
  sweepFlows();
  const redirectUrl = `${origin}/api/integrations/oauth/callback`;
  const flow: Flow = { id, state: crypto.randomBytes(24).toString("hex"), redirectUrl, at: Date.now() };
  flows.set(flow.state, flow);
  const r = await withTimeout(auth(new Provider(id, redirectUrl, flow), { serverUrl: e.url }), 30000);
  if (r === "AUTHORIZED") { flows.delete(flow.state); await finishConnection(id, "oauth"); return { url: "" }; } // (still signed in from before)
  if (!flow.authUrl) throw new Error("noAuthUrl");
  return { url: flow.authUrl.toString() };
}
// The browser is back from the sign-in page. Returns which integration it was and how it went.
export async function finishOAuth(state: string, code: string | undefined, error: string | undefined): Promise<{ id?: string; ok: boolean; error?: string }> {
  sweepFlows();
  const flow = flows.get(state);
  if (!flow) return { ok: false, error: "expired" };
  flows.delete(state);
  if (error || !code) return { id: flow.id, ok: false, error: `denied:${String(error ?? "no code").slice(0, 120)}` };
  const e = lookup(flow.id);
  if (!e) return { ok: false, error: "unknown" };
  try {
    const r = await withTimeout(auth(new Provider(flow.id, flow.redirectUrl, flow), { serverUrl: e.url, authorizationCode: code }), 30000);
    if (r !== "AUTHORIZED") return { id: flow.id, ok: false, error: "error:the service did not accept the sign-in" };
    const pr = await finishConnection(flow.id, "oauth");
    return { id: flow.id, ok: pr.ok, error: pr.error };
  } catch (err) { return { id: flow.id, ok: false, error: `error:${String((err as Error).message).replace(/\s+/g, " ").slice(0, 160)}` }; }
}
// Signed in: check the server with the new token and list what it offers.
async function finishConnection(id: string, method: Method): Promise<Probe> {
  const e = lookup(id)!;
  update(id, (s) => ({ ...s, added: true, method }));
  const pr = await probe(e, await credentialHeaders(id), !!read().items[id]?.readOnly);
  update(id, (s) => ({ ...s, added: true, method, ok: pr.ok, error: pr.ok ? undefined : pr.error, checkedAt: Date.now(), ...(pr.ok ? { tools: pr.tools } : {}) }));
  return pr;
}

// The headers that authenticate to a server right now (an OAuth token is renewed first when it is about to run out).
const refreshing = new Map<string, Promise<void>>();
const expiring = (o: OAuthStored) => { const t = o.tokens; if (!t?.expires_in || !o.savedAt) return false; return o.savedAt + t.expires_in * 1000 - 90e3 < Date.now(); };
function renew(id: string, force = false): Promise<void> {
  const e = lookup(id), o = read().items[id]?.oauth;
  if (!e || !o?.tokens || (!force && !expiring(o))) return Promise.resolve();
  const running = refreshing.get(id);
  if (running) return running;
  const job = (async () => {
    try {
      const r = await withTimeout(auth(new Provider(id, o.redirectUrl), { serverUrl: e.url }), 30000); // (with a refresh token this renews; without one it wants a new sign-in)
      if (r !== "AUTHORIZED") update(id, (s) => ({ ...s, ok: false, error: "reauth" }));
    } catch { update(id, (s) => ({ ...s, ok: false, error: "reauth" })); }
    finally { refreshing.delete(id); }
  })();
  refreshing.set(id, job);
  return job;
}
export async function credentialHeaders(id: string, forceRenew = false): Promise<Record<string, string>> {
  const e = lookup(id), s = read().items[id];
  if (!e || !s) return {};
  if (s.method === "oauth") { await renew(id, forceRenew); const t = read().items[id]?.oauth?.tokens; return t ? { Authorization: `Bearer ${t.access_token}` } : {}; }
  return tokenHeaders(e, s.token);
}

// ---- talking to a server: initialize + list its tools (what "Check" does) ----
export interface Probe { ok: boolean; tools?: ToolInfo[]; error?: string }
export async function probe(e: CatalogEntry, headers: Record<string, string>, readOnly: boolean): Promise<Probe> {
  const client = new Client({ name: "pixel-office", version: "1" });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(urlOf(e, readOnly)), { requestInit: { headers } });
    await withTimeout(client.connect(transport));
    const tools: ToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page++) {
      const r = await withTimeout(client.listTools(cursor ? { cursor } : undefined));
      for (const t of r.tools) tools.push({ name: t.name.slice(0, 120), readOnly: e.readsOnly === true || t.annotations?.readOnlyHint === true, desc: String(t.description ?? "").split("\n")[0].slice(0, 200) });
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return { ok: true, tools };
  } catch (err) {
    const m = String((err as Error)?.message ?? err);
    const code = /\b(401|403)\b|unauthor|forbidden|invalid_token|access token/i.test(m) ? "auth" : /timeout/i.test(m) ? "timeout" : /ENOTFOUND|ECONNREFUSED|fetch failed|EAI_AGAIN/i.test(m) ? "offline" : "error";
    return { ok: false, error: code === "error" ? `error:${m.replace(/\s+/g, " ").slice(0, 160)}` : code };
  } finally { await client.close().catch(() => {}); }
}

// ---- the public view (never carries a credential) ----
export interface IntegrationView {
  id: string; name: string; category: string; desc: { en: string; tr?: string }; icon?: string; brand?: string; host: string; custom: boolean; featured: boolean;
  methods: Method[]; method?: Method; tokenSpec?: { help?: string; hint?: string; optional?: boolean }; beta: boolean; canReadOnly: boolean;
  ownClient?: { group: string; set: boolean; idHint?: string };
  added: boolean; keyHint?: string; readOnly: boolean; ok?: boolean; error?: string; checkedAt?: number; tools?: { total: number; read: number; write: number; names: ToolInfo[] };
}
function viewOf(e: CatalogEntry, s: Stored | undefined): IntegrationView {
  const tools = s?.tools;
  const own = e.ownClient ? read().clients[e.ownClient] : undefined;
  return {
    id: e.id, name: e.name, category: e.category, desc: e.desc, icon: e.icon, brand: e.brand, host: new URL(e.url).host, custom: !!e.custom, featured: !!e.featured,
    methods: [e.oauth ? "oauth" : null, e.token ? "token" : null, e.open ? "open" : null].filter(Boolean) as Method[], method: s?.added ? s.method : undefined,
    ownClient: e.ownClient ? { group: e.ownClient, set: !!own, idHint: own ? `…${own.id.slice(0, 12)}` : undefined } : undefined,
    tokenSpec: e.token ? { help: e.token.help, hint: e.token.hint, optional: e.token.optional } : undefined, beta: !!e.beta, canReadOnly: true,
    added: !!s?.added, keyHint: s?.method === "token" ? hint(s.token) : undefined, readOnly: !!s?.readOnly, ok: s?.ok, error: s?.error, checkedAt: s?.checkedAt,
    tools: tools ? { total: tools.length, read: tools.filter((t) => t.readOnly).length, write: tools.filter((t) => !t.readOnly).length, names: tools } : undefined,
  };
}
export function listIntegrations(): IntegrationView[] {
  const f = read();
  return allEntries().map((e) => viewOf(e, f.items[e.id]));
}
export const viewById = (id: string): IntegrationView | undefined => { const e = lookup(id); return e ? viewOf(e, read().items[id]) : undefined; };

// ---- the OAuth client of a service that does not register clients itself (Google) ----
// The boss makes one with the service (a client id and secret) and pastes it once; every integration of that group shares it.
export function setOwnClient(group: string, id: string, secret: string): boolean {
  if (!allEntries().some((e) => e.ownClient === group)) return false;
  const f = read();
  const cid = id.trim().slice(0, 300);
  if (!cid) delete f.clients[group]; else f.clients[group] = { id: cid, secret: secret.trim().slice(0, 300) || undefined };
  write(f);
  return true;
}

// ---- adding, checking, removing ----
// A pasted token is checked against the server before it is kept: a refused one is not saved. `add` alone is for open servers.
export async function saveIntegration(id: string, patch: { token?: string; readOnly?: boolean; add?: boolean }): Promise<{ view: IntegrationView; probe?: Probe }> {
  const e = lookup(id);
  if (!e) throw new Error("unknown");
  const cur = read().items[id] ?? {};
  const next: Stored = { ...cur };
  if (patch.token !== undefined) next.token = patch.token.trim().slice(0, 4000) || undefined;
  if (patch.readOnly !== undefined) next.readOnly = !!patch.readOnly; // (the gateway enforces it for any server, from the tools it reported)
  let pr: Probe | undefined;
  const wantsToken = patch.token !== undefined && !!next.token;
  if (patch.token !== undefined || patch.readOnly !== undefined || patch.add === true) {
    const method: Method | undefined = wantsToken ? "token" : patch.token === "" ? (e.open ? "open" : undefined) : cur.method ?? (e.open ? "open" : undefined);
    if (!method) { next.added = false; next.method = undefined; next.tools = undefined; next.ok = undefined; next.error = undefined; next.checkedAt = undefined; }
    else {
      const headers = method === "token" ? tokenHeaders(e, next.token) : method === "oauth" ? await credentialHeaders(id) : {};
      pr = await probe(e, headers, !!next.readOnly);
      if (!pr.ok && wantsToken) return { view: viewOf(e, cur), probe: pr }; // a token the server refuses is not kept
      next.added = true; next.method = method;
      next.ok = pr.ok; next.error = pr.ok ? undefined : pr.error; next.checkedAt = Date.now();
      if (pr.ok) next.tools = pr.tools;
    }
  }
  const f = read();
  f.items[id] = next;
  write(f);
  return { view: viewOf(e, next), probe: pr };
}
export async function checkIntegration(id: string): Promise<IntegrationView> {
  const e = lookup(id);
  if (!e) throw new Error("unknown");
  const s = read().items[id];
  if (!s?.added) return viewOf(e, s);
  const pr = await probe(e, await credentialHeaders(id), !!s.readOnly);
  update(id, (x) => ({ ...x, ok: pr.ok, error: pr.ok ? undefined : pr.error, checkedAt: Date.now(), ...(pr.ok ? { tools: pr.tools } : {}) }));
  return viewOf(e, read().items[id]);
}
export function removeIntegration(id: string): IntegrationView | undefined {
  const e = lookup(id);
  if (!e) throw new Error("unknown");
  const f = read();
  delete f.items[id];
  if (e.custom) delete f.custom[id];
  write(f);
  return e.custom ? undefined : viewOf(e, undefined);
}
// A server the boss defines: a name and an address, and how it signs in. Checked before it is kept.
export async function addCustom(input: { name: string; url: string; auth: "none" | "token" | "oauth"; header?: string; token?: string; desc?: string }): Promise<{ view?: IntegrationView; probe?: Probe; error?: string }> {
  const name = String(input.name ?? "").trim().slice(0, 60), url = String(input.url ?? "").trim();
  if (!name || !safeUrl(url)) return { error: "badBody" };
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 18) || "server";
  const f = read();
  let id = `custom_${slug}`;
  for (let n = 2; f.custom[id] || allEntries().some((e) => e.id === id); n++) id = `custom_${slug}_${n}`;
  const def: CustomDef = { name, url, desc: String(input.desc ?? "").trim().slice(0, 200) || undefined, oauth: input.auth === "oauth" || undefined, token: input.auth === "token" ? { header: String(input.header ?? "").trim().slice(0, 60) || undefined } : undefined };
  f.custom[id] = def;
  write(f);
  if (input.auth === "oauth") return { view: viewOf(customEntry(id, def), undefined) }; // it still has to be signed in to
  const r = await saveIntegration(id, input.auth === "token" ? { token: String(input.token ?? "") } : { add: true });
  if (!r.view.added || (r.probe && !r.probe.ok)) { const g = read(); delete g.custom[id]; delete g.items[id]; write(g); return { probe: r.probe, error: r.probe?.error ?? "auth" }; } // not reachable / refused: nothing is kept
  return { view: r.view, probe: r.probe };
}

// ---- what an employee's session gets: only the gateway's address ----
export interface Grant { id: string; readTools: string[]; writeTools: string[]; readOnly: boolean }
export const isReady = (id: string): boolean => {
  const e = lookup(id), s = read().items[id];
  if (!e || !s?.added || s.ok === false) return false;
  return s.method === "oauth" ? !!s.oauth?.tokens : s.method === "token" ? !!s.token : true;
};
export function grantsFor(ids: string[] | undefined): Grant[] {
  if (!ids?.length) return [];
  const f = read();
  const out: Grant[] = [];
  for (const id of ids) {
    const s = f.items[id];
    if (!lookup(id) || !isReady(id) || !s) continue;
    const tools = s.tools ?? [];
    out.push({ id, readTools: tools.filter((t) => t.readOnly).map((t) => t.name), writeTools: tools.filter((t) => !t.readOnly).map((t) => t.name), readOnly: !!s.readOnly });
  }
  return out;
}
// Claude: the servers, the tools that need no question (the ones the server itself says only read), and, when the boss asked for
// read-only, the tools that could change something are refused outright. Every other tool asks first, like any tool.
export function claudeSession(ids: string[] | undefined, gwUrl: (id: string) => string): { servers: Record<string, { type: "http"; url: string }>; allowed: string[]; denied: string[] } {
  const servers: Record<string, { type: "http"; url: string }> = {};
  const allowed: string[] = [], denied: string[] = [];
  for (const g of grantsFor(ids)) {
    servers[g.id] = { type: "http", url: gwUrl(g.id) };
    for (const n of g.readTools) allowed.push(`mcp__${g.id}__${n}`);
    if (g.readOnly) for (const n of g.writeTools) denied.push(`mcp__${g.id}__${n}`);
  }
  return { servers, allowed, denied };
}
// Codex and Gemini cannot stop and ask: they get only the tools the server marks read-only, and only for servers that were checked.
export interface FixedMcp { id: string; url: string; tools: string[] }
export function readOnlySession(ids: string[] | undefined, gwUrl: (id: string) => string): FixedMcp[] {
  return grantsFor(ids).filter((g) => g.readTools.length).map((g) => ({ id: g.id, url: gwUrl(g.id), tools: g.readTools }));
}

// ---- the gateway: /gw/<employee token>/<integration> ----
// A transparent MCP (streamable HTTP) proxy: the request goes to the real server with the current credential added, the answer (JSON or
// an event stream) comes back as it is. On the way it refuses a tool the boss put out of reach (read-only mode) and renews an OAuth
// token that ran out. The caller has already checked that this employee was given this integration.
const PASS_REQUEST = ["mcp-session-id", "mcp-protocol-version", "last-event-id"];
const PASS_RESPONSE = ["content-type", "mcp-session-id", "cache-control"];
const rpcError = (id: unknown, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code: -32001, message } });
export async function gateway(req: Request, res: Response, id: string): Promise<void> {
  const e = lookup(id), s = read().items[id];
  if (!e || !s?.added || !isReady(id)) { res.status(404).json(rpcError(null, "This integration is not available")); return; }
  const body = req.method === "POST" ? req.body : undefined;
  const messages: Array<{ id?: unknown; method?: string; params?: { name?: unknown } }> = Array.isArray(body) ? body : body ? [body] : [];
  const blocked = new Set(s.readOnly ? (s.tools ?? []).filter((t) => !t.readOnly).map((t) => t.name) : []);
  const denied = messages.filter((m) => m && m.method === "tools/call" && blocked.has(String(m.params?.name)));
  if (denied.length) {
    res.status(200).json(!Array.isArray(body) ? rpcError(denied[0].id, "The boss put this integration in read-only mode: this tool would change something") : messages.map((m) => rpcError(m.id, denied.includes(m) ? "Read-only mode: this tool would change something" : "Not run: another call in this batch is refused")));
    return;
  }
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const send = (headers: Record<string, string>) => {
    const h: Record<string, string> = { accept: String(req.headers.accept ?? "application/json, text/event-stream"), ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    for (const k of PASS_REQUEST) if (typeof req.headers[k] === "string") h[k] = String(req.headers[k]);
    return fetch(urlOf(e, !!s.readOnly), { method: req.method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, signal: abort.signal, redirect: "manual" });
  };
  try {
    let up = await send(await credentialHeaders(id));
    if (up.status === 401 && s.method === "oauth") { await up.body?.cancel().catch(() => {}); up = await send(await credentialHeaders(id, true)); } // the token may have been revoked or aged out: renew once
    if (up.status === 401 && s.method === "oauth") update(id, (x) => ({ ...x, ok: false, error: "reauth" }));
    res.status(up.status);
    for (const k of PASS_RESPONSE) { const v = up.headers.get(k); if (v) res.setHeader(k, v); }
    if (!up.body) { res.end(); return; }
    const stream = Readable.fromWeb(up.body as never);
    stream.on("error", () => { try { res.end(); } catch { /* the client is gone */ } });
    stream.pipe(res);
  } catch (err) {
    if (abort.signal.aborted) return;
    if (!res.headersSent) res.status(502).json(rpcError(null, `Could not reach the server: ${String((err as Error).message).slice(0, 120)}`));
    else res.end();
  }
}
