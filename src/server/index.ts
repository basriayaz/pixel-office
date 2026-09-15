import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { Employee, refreshPrompt, type EmployeeConfig } from "./employee.js";
import { Store } from "./store.js";
import { expandHome, loadEmployees, loadEmployee, listSkills, writeAgentFile, createEmployeeDir, archiveEmployeeDir, writeSkill, readSkill, deleteSkill, syncClaudeAgents } from "./agents.js";
import { loadSettings, configPath, PKG_ROOT, CONFIG_DIR } from "./config.js";
import { loadLocale, availableLocales, Translator } from "./i18n.js";
import { initRuntime, t } from "./runtime.js";

const PROJECT = path.resolve(process.env.PIXEL_OFFICE_PROJECT ?? process.cwd());
const settings = loadSettings(PROJECT);
const locale = loadLocale(settings.locale);
initRuntime(settings, new Translator(locale.data));
if (!fs.existsSync(configPath(PROJECT))) console.log(`No ${CONFIG_DIR}/config.json in ${PROJECT} — using defaults (run "pixel-office init" to create one).`);

const store = new Store(settings.dataDir);
const employees = new Map<string, Employee>();
for (const cfg of loadEmployees()) {
  if (employees.has(cfg.id)) throw new Error(t("server.duplicateId", { id: cfg.id }));
  employees.set(cfg.id, new Employee(cfg, store));
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(PKG_ROOT, "web")));

function publicInfo(e: Employee) {
  const { id, name, role, color, look } = e.cfg;
  return { id, name, role, color, look, status: e.status, cost: e.cost, model: e.model ?? e.cfg.model ?? null };
}

const readText = (p?: string) => { try { return p ? fs.readFileSync(p, "utf8") : ""; } catch { return ""; } };
const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const PERMS = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"] as const;
const clean = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const pick = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (list as readonly string[]).includes(v as string) ? (v as T) : undefined;

// Client-side strings and options, served as a script so static pages can use them synchronously.
const clientConfig = {
  locale: locale.code,
  locales: availableLocales(),
  strings: { ui: locale.data.ui, rooms: locale.data.rooms, status: locale.data.status },
  models: MODELS, efforts: EFFORTS, permissions: PERMS,
  project: PROJECT, employeesDir: settings.employeesDir, memoryFile: settings.memoryFile, archiveDir: path.join(path.relative(PROJECT, settings.employeesDir), "_archive"),
};
app.get("/i18n.js", (_req, res) => { res.type("application/javascript").send(`window.PO = ${JSON.stringify(clientConfig)};`); });
app.get("/api/options", (_req, res) => res.json(clientConfig));
app.get("/api/employees", (_req, res) => res.json([...employees.values()].map(publicInfo)));

app.get("/api/employees/:id/detail", (req, res) => {
  const e = employees.get(req.params.id);
  if (!e) return res.status(404).json({ error: t("server.notFound") });
  const userMsgs = e.history.filter((m) => m.role === "user").length;
  res.json({
    ...publicInfo(e),
    cwd: e.cfg.cwd,
    hired: e.cfg.hired ?? null,
    effort: e.cfg.effort ?? null,
    configuredModel: e.cfg.model ?? null,
    permissionMode: e.cfg.permissionMode ?? "default",
    allowedTools: e.cfg.allowedTools ?? [],
    prompt: e.cfg.systemPrompt,
    agentFile: e.cfg.agentFile ?? null,
    memoryFile: e.cfg.memoryFile ?? null,
    memory: readText(e.cfg.memoryFile),
    skills: listSkills(e.cfg.pluginDir),
    skillsDir: e.cfg.pluginDir ? path.join(e.cfg.pluginDir, "skills") : null,
    refreshHours: e.cfg.refreshHours ?? 0,
    lastRefresh: store.getMeta<number>(e.cfg.id, "lastRefresh") ?? null,
    stats: { messages: e.history.length, tasks: userMsgs, lastActivity: e.lastActivity || null },
    recent: e.history.slice(-30),
  });
});

app.put("/api/employees/:id/memory", (req, res) => {
  const e = employees.get(req.params.id);
  if (!e?.cfg.memoryFile) return res.status(404).json({ error: t("server.noMemory") });
  const text = typeof req.body?.text === "string" ? req.body.text : null;
  if (text === null) return res.status(400).json({ error: t("server.textRequired") });
  fs.writeFileSync(e.cfg.memoryFile, text.endsWith("\n") ? text : text + "\n");
  res.json({ ok: true });
});

function startRefresh(e: Employee) {
  e.send(refreshPrompt(), true);
  store.setMeta(e.cfg.id, "lastRefresh", Date.now());
}

app.post("/api/employees/:id/refresh", (req, res) => {
  const e = employees.get(req.params.id);
  if (!e) return res.status(404).json({ error: t("server.notFound") });
  if (e.status === "working" || e.status === "waiting") return res.status(409).json({ error: t("server.busy") });
  startRefresh(e);
  res.json({ ok: true });
});

app.post("/api/employees/:id/reset", async (req, res) => {
  const e = employees.get(req.params.id);
  if (!e) return res.status(404).json({ error: t("server.notFound") });
  await e.reset();
  res.json({ ok: true });
});

// ---- HR: hire / update / fire / skills ----
const roster = () => [...employees.values()].map(publicInfo);
const syncAgents = () => syncClaudeAgents([...employees.values()].map((e) => e.cfg));

app.post("/api/employees", (req, res) => {
  const b = req.body ?? {};
  const name = clean(b.name, 40), role = clean(b.role, 60), prompt = clean(b.prompt, 20000);
  if (!name || !role) return res.status(400).json({ error: t("server.nameRoleRequired") });
  const look = typeof b.look === "object" && b.look ? b.look : undefined;
  const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : "#56b6c2";
  const dir = createEmployeeDir({
    name, role, color, prompt: prompt || t("server.defaultPrompt", { name, role }),
    look: look ?? { skin: "#f1c9a5", hair: "#3b2a20", hairStyle: "short", top: color, bottom: "#2f3548", accessory: "none" },
    model: pick(b.model, MODELS), effort: pick(b.effort, EFFORTS), permissionMode: pick(b.permissionMode, PERMS),
    cwd: clean(b.cwd, 500) || undefined,
  });
  const e = new Employee(loadEmployee(dir, employees.size), store);
  employees.set(e.cfg.id, e);
  wire(e);
  syncAgents();
  broadcast({ type: "init", employees: roster() });
  res.json(publicInfo(e));
});

app.put("/api/employees/:id", async (req, res) => {
  const e = employees.get(req.params.id);
  if (!e) return res.status(404).json({ error: t("server.notFound") });
  const b = req.body ?? {};
  const cfg: EmployeeConfig = { ...e.cfg };
  if (b.name !== undefined) cfg.name = clean(b.name, 40) || cfg.name;
  if (b.role !== undefined) cfg.role = clean(b.role, 60) || cfg.role;
  if (b.prompt !== undefined) cfg.systemPrompt = clean(b.prompt, 20000) || cfg.systemPrompt;
  if (b.color !== undefined && /^#[0-9a-f]{6}$/i.test(b.color)) cfg.color = b.color;
  if (b.look && typeof b.look === "object") cfg.look = b.look;
  if (b.model !== undefined) cfg.model = pick(b.model, MODELS);
  if (b.effort !== undefined) cfg.effort = pick(b.effort, EFFORTS);
  if (b.permissionMode !== undefined) cfg.permissionMode = pick(b.permissionMode, PERMS) ?? "default";
  if (b.refreshHours !== undefined) cfg.refreshHours = Math.max(0, Number(b.refreshHours) || 0);
  if (b.cwd !== undefined) { const c = clean(b.cwd, 500); cfg.cwd = c ? expandHome(c) : settings.cwd; }
  writeAgentFile(cfg);
  await e.applyConfig(cfg);
  syncAgents();
  broadcast({ type: "init", employees: roster() });
  res.json(publicInfo(e));
});

app.delete("/api/employees/:id", async (req, res) => {
  const e = employees.get(req.params.id);
  if (!e) return res.status(404).json({ error: t("server.notFound") });
  await e.dispose();
  employees.delete(e.cfg.id);
  store.setSession(e.cfg.id, undefined);
  store.deleteHistory(e.cfg.id);
  const archived = e.cfg.dir ? archiveEmployeeDir(e.cfg.dir) : null;
  syncAgents();
  broadcast({ type: "init", employees: roster() });
  res.json({ ok: true, archived });
});

app.post("/api/employees/:id/skills", async (req, res) => {
  const e = employees.get(req.params.id);
  if (!e?.cfg.pluginDir) return res.status(404).json({ error: t("server.notFound") });
  const name = clean(req.body?.name, 40), description = clean(req.body?.description, 300), body = clean(req.body?.body, 30000);
  if (!name || !description) return res.status(400).json({ error: t("server.skillFields") });
  const id = writeSkill(e.cfg.pluginDir, name, description, body || t("server.skillBody", { name }));
  await e.applyConfig(e.cfg);
  res.json({ ok: true, name: id });
});

app.get("/api/employees/:id/skills/:skill", (req, res) => {
  const e = employees.get(req.params.id);
  const s = e?.cfg.pluginDir ? readSkill(e.cfg.pluginDir, req.params.skill) : null;
  if (!s) return res.status(404).json({ error: t("server.notFound") });
  res.json(s);
});

app.delete("/api/employees/:id/skills/:skill", async (req, res) => {
  const e = employees.get(req.params.id);
  if (!e?.cfg.pluginDir) return res.status(404).json({ error: t("server.notFound") });
  deleteSkill(e.cfg.pluginDir, req.params.skill);
  await e.applyConfig(e.cfg);
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(payload: unknown) {
  const data = JSON.stringify(payload);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
}

function wire(e: Employee) {
  const id = e.cfg.id;
  e.on("status", (status, reason) => broadcast({ type: "status", id, status, reason }));
  e.on("message", (message) => broadcast({ type: "message", id, message }));
  e.on("chunk", (text) => broadcast({ type: "chunk", id, text }));
  e.on("chunk_end", () => broadcast({ type: "chunk_end", id }));
  e.on("ask", (request) => broadcast({ type: "ask", id, request }));
  e.on("ask_done", (requestId) => broadcast({ type: "ask_done", id, requestId }));
  e.on("result", (r) => broadcast({ type: "result", id, ...r, model: e.model }));
  e.on("reset", () => {
    broadcast({ type: "history", id, messages: [], pending: [] });
    broadcast({ type: "result", id, cost: 0, durationMs: 0 });
  });
}
for (const e of employees.values()) wire(e);
syncAgents();

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "init", employees: roster() }));
  ws.on("message", async (raw) => {
    let msg: { type: string; id?: string; text?: string; requestId?: string; allow?: boolean; always?: boolean; answers?: Record<string, unknown> };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const e = msg.id ? employees.get(msg.id) : undefined;
    if (!e) return;
    switch (msg.type) {
      case "open": ws.send(JSON.stringify({ type: "history", id: e.cfg.id, messages: e.history, pending: e.pendingAsks })); break;
      case "send": if (msg.text?.trim()) e.send(msg.text.trim()); break;
      case "reply": if (msg.requestId) e.reply(msg.requestId, { allow: !!msg.allow, always: !!msg.always, answers: msg.answers }); break;
      case "interrupt": await e.interrupt(); break;
      case "reset": await e.reset(); break;
      case "refresh": if (e.status === "idle" || e.status === "error") startRefresh(e); break;
    }
  });
});

// Self-refresh: idle employees revisit their memory and project docs every `refreshHours` (only if they worked since last time).
setInterval(() => {
  const now = Date.now();
  for (const e of employees.values()) {
    const hours = e.cfg.refreshHours ?? 0;
    if (hours <= 0 || e.status !== "idle") continue;
    const last = store.getMeta<number>(e.cfg.id, "lastRefresh") ?? 0;
    if (now - last < hours * 3600e3 || e.lastActivity <= last) continue;
    startRefresh(e);
  }
}, 10 * 60e3);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") { console.error(t("server.portInUse", { port: settings.port })); process.exit(1); }
  throw err;
});

server.listen(settings.port, settings.host, () => {
  const url = `http://localhost:${settings.port}`;
  console.log(t("server.open", { port: settings.port }));
  if (settings.host !== "127.0.0.1") console.log(t("server.hostWarning", { host: settings.host }));
  console.log(`  project: ${PROJECT}\n  employees: ${settings.employeesDir}`);
  for (const e of employees.values()) console.log(`  - ${e.cfg.name} (${e.cfg.role})`);
  if (process.env.PIXEL_OFFICE_OPEN === "1") {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref(); } catch {}
  }
});

async function shutdown() {
  await Promise.all([...employees.values()].map((e) => e.interrupt().catch(() => {})));
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
