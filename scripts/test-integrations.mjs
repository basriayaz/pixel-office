// Integrations (src/server/integrations.ts): the catalogue is valid, a key is checked against a real MCP server before it is kept, "sign in with
// your account" runs the whole OAuth flow (discovery, registration, PKCE, refresh), the gateway adds the credential and enforces read-only,
// the browser never sees a secret, and a session gets exactly the servers and tools it should.
// Runs against dist/ (npm run build) with a local MCP + OAuth server standing in for a service.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const I = await import(path.join(root, "dist/server/integrations.js"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "po-integrations-"));
I.initIntegrations(dir);

// ---------- the catalogue ----------
const cat = I.listIntegrations();
const ids = cat.map((e) => e.id);
assert.ok(cat.length >= 120, "a real catalogue");
assert.equal(new Set(ids).size, ids.length, "unique ids");
const cats = I.CATEGORIES();
for (const e of cat) {
  assert.match(e.id, /^[a-z][a-z0-9_]*$/, `${e.id}: a valid MCP server name`);
  assert.ok(cats.includes(e.category), `${e.id}: a known category`);
  assert.ok(e.desc.en && e.desc.tr, `${e.id}: described in both languages`);
  assert.ok(e.methods.length, `${e.id}: at least one way in`);
  if (e.icon) assert.ok(fs.existsSync(path.join(root, "web/logos/int", /\.(png|svg)$/.test(e.icon) ? e.icon : `${e.icon}.svg`)), `${e.id}: its logo file exists`);
  if (e.brand) assert.match(e.brand, /^#[0-9a-f]{6}$/i, `${e.id}: brand colour`);
  if (e.tokenSpec?.help) assert.ok(e.tokenSpec.help.startsWith("https://"), `${e.id}: help link`);
  assert.ok(!e.added && e.tools === undefined, "nothing is added at the start");
}
for (const id of ["github", "notion", "linear", "context7", "stripe"]) assert.ok(ids.includes(id), id);
assert.ok(cat.filter((e) => e.methods.includes("oauth")).length >= 60, "most of them offer sign-in with an account");
for (const f of fs.readdirSync(path.join(root, "web/logos/int")).filter((n) => n.endsWith(".svg"))) { const svg = fs.readFileSync(path.join(root, "web/logos/int", f), "utf8"); assert.ok(svg.startsWith("<svg") && !/<script|onload/i.test(svg), `${f}: a plain svg`); }

// ---------- a stand-in service: MCP with keys, MCP behind OAuth, and the OAuth server itself ----------
const seen = [];
const codes = new Map(), validTokens = new Set(), refreshTokens = new Set();
let registrations = 0, refreshes = 0;
let base = "";
const json = (res, code, obj, headers = {}) => res.writeHead(code, { "content-type": "application/json", ...headers }).end(JSON.stringify(obj));
async function mcpAnswer(req, res, body, readOnlyQuery) {
  const mcp = new McpServer({ name: "mock", version: "1" });
  mcp.registerTool("read_thing", { description: "Reads a thing.\nSecond line.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  mcp.registerTool("list_things", { description: "Lists.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  if (!readOnlyQuery) mcp.registerTool("write_thing", { description: "Changes a thing.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: false } }, async () => ({ content: [{ type: "text", text: "wrote" }] }));
  mcp.registerTool("unmarked", { description: "No hint at all.", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void t.close(); void mcp.close(); });
  await mcp.connect(t);
  await t.handleRequest(req, res, body ? JSON.parse(body) : undefined);
}
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  seen.push({ url: req.url, auth: req.headers.authorization, key: req.headers["x-api-key"] });
  // --- OAuth server ---
  if (p === "/.well-known/oauth-protected-resource/o/mcp") return json(res, 200, { resource: `${base}/o/mcp`, authorization_servers: [base] });
  if (p === "/.well-known/oauth-authorization-server") return json(res, 200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
  if (p === "/register") { registrations++; const m = JSON.parse(body); assert.ok(m.redirect_uris[0].endsWith("/api/integrations/oauth/callback")); return json(res, 201, { ...m, client_id: "client-1" }); }
  if (p === "/token") {
    const f = new URLSearchParams(body);
    if (f.get("grant_type") === "authorization_code") {
      const c = codes.get(f.get("code"));
      if (!c || crypto.createHash("sha256").update(f.get("code_verifier") || "").digest("base64url") !== c.challenge) return json(res, 400, { error: "invalid_grant" });
      codes.delete(f.get("code"));
      const at = `at-${crypto.randomBytes(4).toString("hex")}`, rt = `rt-${crypto.randomBytes(4).toString("hex")}`;
      validTokens.add(at); refreshTokens.add(rt);
      return json(res, 200, { access_token: at, token_type: "Bearer", expires_in: 3600, refresh_token: rt });
    }
    if (f.get("grant_type") === "refresh_token" && refreshTokens.has(f.get("refresh_token"))) {
      refreshes++;
      const at = `at-${crypto.randomBytes(4).toString("hex")}`;
      validTokens.add(at);
      return json(res, 200, { access_token: at, token_type: "Bearer", expires_in: 3600, refresh_token: f.get("refresh_token") });
    }
    return json(res, 400, { error: "invalid_grant" });
  }
  // --- MCP behind OAuth ---
  if (p === "/o/mcp") {
    const tok = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!validTokens.has(tok)) return json(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/o/mcp"` });
    return mcpAnswer(req, res, body, false);
  }
  // --- MCP with keys / open ---
  const want = p.startsWith("/open") ? null : p.startsWith("/keyed") ? "x-api-key" : "authorization";
  const ok = want === null || (want === "authorization" ? req.headers.authorization === "Bearer good-token" : req.headers["x-api-key"] === "good-key");
  if (!ok) return json(res, 401, { error: "invalid_token" }, { "www-authenticate": 'Bearer error="invalid_token"' });
  return mcpAnswer(req, res, body, url.searchParams.has("read_only"));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${server.address().port}`;
I.extraCatalog.push(
  { id: "mock", name: "Mock", category: "code", url: `${base}/mcp`, desc: { en: "m" }, token: { help: "https://example.com/token" }, readOnly: { query: { read_only: "true" } } },
  { id: "mockopen", name: "Mock Open", category: "docs", url: `${base}/open`, desc: { en: "m" }, open: true, readsOnly: true },
  { id: "mockkey", name: "Mock Key", category: "docs", url: `${base}/keyed`, desc: { en: "m" }, token: { header: "x-api-key", prefix: "", optional: true } },
  { id: "mockoauth", name: "Mock OAuth", category: "work", url: `${base}/o/mcp`, desc: { en: "m" }, oauth: true },
);
const file = path.join(dir, "integrations.json");

// ---------- a key is checked before it is kept ----------
let r = await I.saveIntegration("mock", { token: "wrong-token" });
assert.equal(r.probe.ok, false);
assert.equal(r.probe.error, "auth", "a refused key is called what it is");
assert.equal(r.view.added, false, "and nothing was saved");
assert.ok(!fs.existsSync(file) || !fs.readFileSync(file, "utf8").includes("wrong-token"), "the bad key is not on disk");
r = await I.saveIntegration("mock", { token: "good-token" });
assert.equal(r.probe.ok, true);
assert.equal(r.view.added, true);
assert.equal(r.view.method, "token");
assert.equal(r.view.keyHint, "…oken", "only the last four characters");
assert.deepEqual([r.view.tools.read, r.view.tools.write, r.view.tools.total], [2, 2, 4], "read-only marks; a tool with no mark counts as one that writes");
assert.equal(r.view.tools.names.find((t) => t.name === "read_thing").desc, "Reads a thing.", "the first line of the description");
assert.equal(seen.at(-1).auth, "Bearer good-token", "the key travels as a bearer header");
const shown = JSON.stringify(I.listIntegrations());
assert.ok(!shown.includes("good-token") && !/"token":/.test(shown) && !/access_token/.test(shown), "the list carries no secret");
assert.ok(fs.readFileSync(file, "utf8").includes("good-token"), "it is on disk, in a file only the owner can read");
if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0, "owner-only file");
assert.ok(!fs.existsSync(`${file}.bak`), "no copy of an old key");

// ---------- read-only, other headers, no key needed ----------
r = await I.saveIntegration("mock", { readOnly: true });
assert.equal(r.view.readOnly, true);
assert.ok(seen.at(-1).url.includes("read_only=true"), "the server is asked for its read-only variant");
assert.deepEqual(r.view.tools.names.map((t) => t.name).sort(), ["list_things", "read_thing", "unmarked"], "the write tool is not even offered");
r = await I.saveIntegration("mockopen", { add: true });
assert.ok(r.view.added && r.view.ok && r.view.method === "open");
assert.deepEqual([r.view.tools.read, r.view.tools.write], [4, 0], "a documentation server marked reads-only: all its tools need no question");
r = await I.saveIntegration("mockkey", { token: "good-key" });
assert.ok(r.probe.ok && seen.at(-1).key === "good-key" && seen.at(-1).auth === undefined, "a service with its own header name gets the key there");
r = await I.saveIntegration("mock", { token: "" });
assert.equal(r.view.added, false, "removing the key removes the integration (it needs one)");
await I.saveIntegration("mock", { token: "good-token" });
assert.equal((await I.checkIntegration("mock")).ok, true);
assert.equal((await I.checkIntegration("deepwiki")).added, false, "checking something that was not added does nothing");
await assert.rejects(() => I.saveIntegration("nope", { token: "x" }));

// ---------- sign in with your account: the whole flow ----------
const origin = "http://localhost:4747";
const { url: authUrl } = await I.startOAuth("mockoauth", origin);
const au = new URL(authUrl);
assert.equal(au.origin + au.pathname, `${base}/authorize`);
assert.equal(au.searchParams.get("client_id"), "client-1", "registered itself with the service");
assert.equal(au.searchParams.get("redirect_uri"), `${origin}/api/integrations/oauth/callback`);
assert.equal(au.searchParams.get("code_challenge_method"), "S256", "PKCE");
assert.ok(au.searchParams.get("state").length >= 32, "an unguessable state");
await assert.rejects(() => I.startOAuth("mock", origin), "not every server offers it");
// the wrong state, or a state twice, is refused
assert.equal((await I.finishOAuth("nope", "c", undefined)).ok, false);
codes.set("code-1", { challenge: au.searchParams.get("code_challenge") });
const back = await I.finishOAuth(au.searchParams.get("state"), "code-1", undefined);
assert.deepEqual([back.id, back.ok], ["mockoauth", true], "the callback finishes the connection and checks it");
assert.equal((await I.finishOAuth(au.searchParams.get("state"), "code-1", undefined)).ok, false, "a state works once");
let v = I.listIntegrations().find((x) => x.id === "mockoauth");
assert.ok(v.added && v.ok && v.method === "oauth" && v.tools.total === 4);
assert.ok(!JSON.stringify(I.listIntegrations()).includes("at-") && !JSON.stringify(I.listIntegrations()).includes("rt-"), "no token in the list");
assert.equal(registrations, 1);
// the user says no
assert.equal((await I.startOAuth("mockoauth", origin)).url, "", "already signed in: nothing to do");
I.extraCatalog.push({ id: "mockoauth2", name: "Mock OAuth 2", category: "work", url: `${base}/o/mcp`, desc: { en: "m" }, oauth: true });
const denied = await I.startOAuth("mockoauth2", origin);
const dr = await I.finishOAuth(new URL(denied.url).searchParams.get("state"), undefined, "access_denied");
assert.deepEqual([dr.ok, dr.id], [false, "mockoauth2"]);
assert.equal(I.listIntegrations().find((x) => x.id === "mockoauth2").added, false, "the user said no: nothing is connected");
assert.equal(I.listIntegrations().find((x) => x.id === "mockoauth").ok, true, "and what was connected stays connected");

// a service that does not register clients itself: the boss's own OAuth client, pasted once and shared by its group
I.extraCatalog.push({ id: "mockown", name: "Mock Own", category: "work", url: `${base}/o/mcp`, desc: { en: "m" }, oauth: true, ownClient: "mockgrp", scopes: "scope.a scope.b" });
assert.equal(I.listIntegrations().find((x) => x.id === "mockown").ownClient.set, false);
await assert.rejects(() => I.startOAuth("mockown", origin), /noClient/, "no client, no sign-in");
assert.equal(I.setOwnClient("nogroup", "x", "y"), false);
assert.ok(I.setOwnClient("mockgrp", "own-client.apps", ""));
const regBefore = registrations;
const ou = new URL((await I.startOAuth("mockown", origin)).url);
assert.equal(ou.searchParams.get("client_id"), "own-client.apps", "the boss's client, not a registered one");
assert.equal(ou.searchParams.get("scope"), "scope.a scope.b", "only the scopes the integration asks for");
assert.equal(registrations, regBefore, "nothing was registered");
codes.set("code-own", { challenge: ou.searchParams.get("code_challenge") });
assert.equal((await I.finishOAuth(ou.searchParams.get("state"), "code-own", undefined)).ok, true);
assert.ok(!JSON.stringify(I.listIntegrations()).includes("own-client.apps"), "only a hint of the client id goes to the browser");
I.removeIntegration("mockown");

// ---------- the gateway ----------
const app = express();
app.use(express.json());
const grants = new Set(["mock", "mockoauth", "mockopen"]);
app.all("/gw/:id", (req, res) => (grants.has(req.params.id) ? I.gateway(req, res, req.params.id) : res.status(404).end()));
const gw = http.createServer(app);
await new Promise((r2) => gw.listen(0, "127.0.0.1", r2));
const gwUrl = (id) => `http://127.0.0.1:${gw.address().port}/gw/${id}`;
async function session(id) {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(gwUrl(id))));
  return c;
}
let c = await session("mockoauth");
assert.equal((await c.listTools()).tools.length, 4, "an OAuth server through the gateway: the session holds no credential");
assert.equal((await c.callTool({ name: "write_thing", arguments: { id: "1" } })).content[0].text, "wrote");
await c.close();
assert.ok(seen.at(-1).auth?.startsWith("Bearer at-"), "the gateway added the token");
// the token stops working (revoked or aged out): renewed with the refresh token, once, and the call goes through
const before = refreshes;
validTokens.clear();
c = await session("mockoauth");
assert.equal((await c.callTool({ name: "read_thing", arguments: { id: "1" } })).content[0].text, "ok", "a stale token is renewed and the call retried");
await c.close();
assert.ok(refreshes > before, "with the refresh token");
// a key server through the gateway
c = await session("mock");
assert.equal((await c.listTools()).tools.length, 3, "(still in read-only mode from above)");
const refused = await c.callTool({ name: "write_thing", arguments: { id: "1" } }).then((x) => x.isError === true, () => true);
assert.ok(refused, "the read-only variant does not have the write tool at all: the call fails");
assert.equal((await c.callTool({ name: "read_thing", arguments: { id: "1" } })).content[0].text, "ok");
await c.close();
assert.equal(seen.filter((s) => s.url.includes("write")).length, 0);
await I.saveIntegration("mock", { readOnly: false });
c = await session("mock");
assert.equal((await c.callTool({ name: "write_thing", arguments: { id: "1" } })).content[0].text, "wrote", "not read-only: it goes through");
await c.close();
// read-only also holds for a server without its own read-only variant (the office enforces it from the tools the server reported)
await I.saveIntegration("mockoauth", { readOnly: true });
c = await session("mockoauth");
await assert.rejects(() => c.callTool({ name: "write_thing", arguments: { id: "1" } }), /read-only|Read-only/);
assert.equal((await c.callTool({ name: "list_things", arguments: {} })).content[0].text, "ok");
await c.close();
await I.saveIntegration("mockoauth", { readOnly: false });
// not connected / not ready
const bad = await fetch(gwUrl("mockkey"), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
assert.equal(bad.status, 404, "the route's own grant check");
await I.removeIntegration("mockopen");
const gone = await fetch(gwUrl("mockopen"), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
assert.equal(gone.status, 404, "an integration that was removed is gone for everyone");
await I.saveIntegration("mockopen", { add: true });

// ---------- what a session gets ----------
const gu = (id) => `http://gw/${id}`;
const s1 = I.claudeSession(["mock", "mockopen", "deepwiki", "github", "nope"], gu);
assert.deepEqual(Object.keys(s1.servers).sort(), ["mock", "mockopen"], "only what is connected, usable and asked for (deepwiki was not added, github has no key)");
assert.deepEqual(s1.servers.mock, { type: "http", url: "http://gw/mock" }, "the session gets the gateway's address and nothing else: no credential");
assert.ok(!JSON.stringify(s1).includes("good-token"));
assert.equal(s1.allowed.filter((n) => n.startsWith("mcp__mockopen__")).length, 4, "the whole documentation server needs no question");
assert.deepEqual(s1.allowed.filter((n) => n.startsWith("mcp__mock__")).sort(), ["mcp__mock__list_things", "mcp__mock__read_thing"], "the tools the server marks read-only need no question; the rest ask");
assert.deepEqual(s1.denied, [], "not read-only mode: nothing is refused outright");
await I.saveIntegration("mock", { readOnly: true });
const s2 = I.claudeSession(["mock"], gu);
assert.deepEqual(s2.denied, ["mcp__mock__unmarked"], "read-only mode refuses outright what the server still offers and does not mark as reading (the write tool is not even offered)");
await I.saveIntegration("mock", { readOnly: false });
assert.deepEqual(I.claudeSession(undefined, gu), { servers: {}, allowed: [], denied: [] });
assert.deepEqual(I.claudeSession([], gu), { servers: {}, allowed: [], denied: [] });
// Codex and Gemini: only the read-only tools
const c2 = I.readOnlySession(["mock", "mockopen", "mockkey"], gu);
assert.deepEqual(c2.find((m) => m.id === "mock").tools.sort(), ["list_things", "read_thing"]);
assert.equal(c2.find((m) => m.id === "mock").url, "http://gw/mock");
assert.ok(!JSON.stringify(c2).includes("good-"), "no secret in what goes on a command line");
// a server that stopped working is not handed out
const items = JSON.parse(fs.readFileSync(file, "utf8")).items;
fs.writeFileSync(file, JSON.stringify({ v: 1, items: { ...items, mockopen: { ...items.mockopen, ok: false, error: "offline" } } }));
assert.deepEqual(Object.keys(I.claudeSession(["mockopen"], gu).servers), [], "one that failed its last check is left out");

// ---------- servers of your own ----------
assert.deepEqual((await I.addCustom({ name: "Bad", url: "http://example.com/mcp", auth: "none" })).error, "badBody", "plain http only for this machine");
let cu = await I.addCustom({ name: "My Docs!", url: `${base}/open/x`, auth: "none" });
assert.equal(cu.view.id, "custom_my_docs");
assert.ok(cu.view.custom && cu.view.added && cu.view.category === "custom" && cu.view.tools.total === 4);
assert.ok(I.CATEGORIES().includes("custom"));
cu = await I.addCustom({ name: "My Docs", url: `${base}/open/y`, auth: "none" });
assert.equal(cu.view.id, "custom_my_docs_2", "a second one with the same name gets its own id");
const badCu = await I.addCustom({ name: "Dead", url: "http://127.0.0.1:1/mcp", auth: "none" });
assert.ok(badCu.error && !I.listIntegrations().some((x) => x.name === "Dead"), "one that cannot be reached is not kept");
const keyed = await I.addCustom({ name: "Keyed", url: `${base}/keyed`, auth: "token", header: "x-api-key", token: "good-key" });
assert.ok(keyed.view.added && keyed.view.method === "token");
assert.ok((await I.addCustom({ name: "Keyed2", url: `${base}/keyed`, auth: "token", header: "x-api-key", token: "wrong" })).error, "a refused key is not kept");
const oa = await I.addCustom({ name: "Later", url: `${base}/o/mcp`, auth: "oauth" });
assert.ok(oa.view.methods.includes("oauth") && !oa.view.added, "an OAuth one waits for the sign-in");
assert.ok(I.entryOf("custom_my_docs"), "found by id like the catalogue's");
I.removeIntegration("custom_my_docs");
assert.equal(I.listIntegrations().some((x) => x.id === "custom_my_docs"), false, "a removed custom server is gone entirely");

// ---------- junk in the file ----------
fs.writeFileSync(file, JSON.stringify({ v: 1, custom: { custom_x: { name: 5, url: "ftp://x" }, "../evil": { name: "e", url: "https://e.com" } }, items: { mock: { added: true, token: 5, tools: "x", ok: "yes" }, nope: { added: true, token: "t" }, github: null } }));
const junk = I.listIntegrations();
assert.equal(junk.find((x) => x.id === "mock").added, true);
assert.equal(junk.find((x) => x.id === "mock").tools, undefined);
assert.ok(!junk.some((x) => x.id === "nope" || x.id === "custom_x" || x.id === "../evil"));
fs.writeFileSync(file, "{oops");
assert.ok(I.listIntegrations().length >= 30, "a broken file is not fatal");

server.close(); gw.close();
console.log("integrations ok:", cat.length, "in the catalogue");
process.exit(0);
