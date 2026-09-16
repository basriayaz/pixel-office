import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import express, { type Request } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { Employee, refreshPrompt, type EmployeeConfig } from "./employee.js";
import { Store } from "./store.js";
import { expandHome, loadEmployees, loadEmployee, listSkills, writeAgentFile, createEmployeeDir, archiveEmployeeDir, writeSkill, readSkill, deleteSkill, syncClaudeAgents } from "./agents.js";
import { loadSettings, configPath, readRawConfig, writeRawConfig, officeDefFromRaw, officeIdOf, absPath, displayPath, rootFromEnv, initRoot, PKG_ROOT, THEMES, type OfficeDef, type Theme } from "./config.js";
import { loadLocale, availableLocales, Translator } from "./i18n.js";
import { initRuntime, t } from "./runtime.js";

const R = rootFromEnv();
// Global mode sets itself up on first run; project mode expects `pixel-office init`.
let firstRun = false;
if (!fs.existsSync(configPath(R))) {
  if (R.mode === "global") { initRoot(R, { locale: process.env.PIXEL_OFFICE_LOCALE }); console.log(`Created ${configPath(R)}`); firstRun = true; }
  else console.log(`No ${configPath(R)} — using defaults (run "pixel-office init" to create one).`);
}
const settings = loadSettings(R);
const locale = loadLocale(settings.locale);
initRuntime(settings, new Translator(locale.data));

interface OfficeRt {
  def: OfficeDef;
  store: Store;
  employees: Map<string, Employee>;
}
const offices = new Map<string, OfficeRt>();

// Store folder per office. A single-office setup that later became multi-office keeps its data by moving it under dataDir/<id>.
function storeFor(def: OfficeDef): Store {
  if (!settings.multiOffice) return new Store(settings.dataDir);
  const dir = path.join(settings.dataDir, def.id);
  if (!fs.existsSync(dir) && fs.existsSync(path.join(settings.dataDir, "history"))) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ["history", "state.json"]) { const src = path.join(settings.dataDir, f); if (fs.existsSync(src)) fs.renameSync(src, path.join(dir, f)); }
  }
  return new Store(dir);
}

function openOffice(def: OfficeDef): OfficeRt {
  if (!def.name) def.name = t("ui.offices.default");
  const store = storeFor(def);
  const employees = new Map<string, Employee>();
  for (const cfg of loadEmployees(def)) {
    if (employees.has(cfg.id)) throw new Error(t("server.duplicateId", { id: cfg.id }));
    employees.set(cfg.id, new Employee(cfg, store));
  }
  const o: OfficeRt = { def, store, employees };
  offices.set(def.id, o);
  for (const e of employees.values()) e.setColleagues({ list: () => [...employees.values()] });
  return o;
}
// A brand-new office gets three sample employees so the first screen isn't empty (PIXEL_OFFICE_SAMPLES=0 disables).
const SAMPLE_LOOKS: Array<{ color: string; look: Record<string, unknown> }> = [
  { color: "#61afef", look: { body: "slim", skin: "#f1c9a5", hair: "#3b2a1a", hairStyle: "short", top: "#61afef", bottom: "#2f3548", glasses: "round", shoes: "sneakers" } },
  { color: "#c678dd", look: { body: "slim", fem: true, skin: "#e9bd9a", hair: "#8a3b1f", hairStyle: "long", top: "#c678dd", bottom: "#2f3548", shoes: "heels" } },
  { color: "#e5c07b", look: { body: "normal", skin: "#c68642", hair: "#1c1a20", hairStyle: "curly", top: "#e5c07b", bottom: "#3f3a4a", topStyle: "hoodie", shoes: "dark" } },
];
function seedSamples(def: OfficeDef) {
  if (process.env.PIXEL_OFFICE_SAMPLES === "0") return;
  const samples = (locale.data.ui as { samples?: Array<{ name: string; preset: number }> }).samples ?? [];
  const presets = (locale.data.ui as { presets?: Array<{ role: string; prompt: string }> }).presets ?? [];
  samples.forEach((sm, i) => {
    const pr = presets[sm.preset]; if (!pr) return;
    const L = SAMPLE_LOOKS[i % SAMPLE_LOOKS.length];
    createEmployeeDir(def, { name: sm.name, role: pr.role, prompt: pr.prompt.replace(/\{name\}/g, sm.name), color: L.color, look: L.look });
  });
}
if (firstRun) seedSamples(settings.offices[0]);
for (const def of settings.offices) openOffice(def);
const defaultOfficeId = () => settings.offices[0].id;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(PKG_ROOT, "web")));

function publicInfo(e: Employee) {
  const { id, name, role, color, look, officeId } = e.cfg;
  return { id, office: officeId, name, role, color, look, status: e.status, cost: e.cost, model: e.model ?? e.cfg.model ?? null };
}

const readText = (p?: string) => { try { return p ? fs.readFileSync(p, "utf8") : ""; } catch { return ""; } };
const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const PERMS = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"] as const;
const clean = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const pick = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (list as readonly string[]).includes(v as string) ? (v as T) : undefined;

const officeInfo = (o: OfficeRt) => ({ id: o.def.id, name: o.def.name, cwd: o.def.cwd, employeesDir: o.def.employeesDir, theme: o.def.theme });
const roster = (o: OfficeRt) => [...o.employees.values()].map(publicInfo);
const syncAgents = (o: OfficeRt) => syncClaudeAgents(o.def, [...o.employees.values()].map((e) => e.cfg));

// Client-side strings and options, served as a script so static pages can use them synchronously.
const clientConfig = () => ({
  locale: locale.code,
  locales: availableLocales(),
  strings: { ui: locale.data.ui, rooms: locale.data.rooms, status: locale.data.status },
  models: MODELS, efforts: EFFORTS, permissions: PERMS, themes: THEMES,
  project: R.defaultCwd, projectDisplay: displayPath(R.defaultCwd), mode: R.mode, root: R.root, firstRun, memoryFile: settings.memoryFile, multiOffice: settings.multiOffice, defaultOffice: defaultOfficeId(),
  offices: [...offices.values()].map(officeInfo),
});
app.get("/i18n.js", (_req, res) => { res.type("application/javascript").send(`window.PO = ${JSON.stringify(clientConfig())};`); });
app.get("/api/options", (_req, res) => res.json(clientConfig()));

// Native "choose folder" dialog on the machine the server runs on (macOS Finder, Windows, zenity/kdialog on Linux).
let picking = false;
app.post("/api/pick-folder", (req, res) => {
  if (picking) return res.status(409).json({ error: t("server.pickBusy") });
  const start = absPath(R.base, String(req.body?.start || ".")) ;
  const prompt = String(req.body?.prompt || "").slice(0, 120);
  let cmd: string, args: string[];
  if (process.platform === "darwin") {
    const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    cmd = "osascript";
    args = ["-e", 'tell application "System Events"', "-e", "activate",
      "-e", `set f to choose folder with prompt "${esc(prompt)}" default location (POSIX file "${esc(start)}")`,
      "-e", "POSIX path of f", "-e", "end tell"];
  } else if (process.platform === "win32") {
    cmd = "powershell";
    args = ["-NoProfile", "-STA", "-Command", `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${prompt.replace(/'/g, "''")}'; $d.SelectedPath = '${start.replace(/'/g, "''")}'; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath } else { exit 1 }`];
  } else {
    cmd = "sh";
    args = ["-c", `if command -v zenity >/dev/null; then zenity --file-selection --directory --title="$1" --filename="$2/"; elif command -v kdialog >/dev/null; then kdialog --getexistingdirectory "$2" --title "$1"; else echo "no dialog tool (install zenity)" >&2; exit 2; fi`, "pick", prompt, start];
  }
  picking = true;
  let out = "", err = "";
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("error", (e) => { picking = false; res.status(500).json({ error: e.message }); });
  child.on("close", (code) => {
    picking = false;
    if (res.headersSent) return;
    const chosen = out.trim().replace(/[\\/]+$/, "");
    if (code !== 0 || !chosen) return res.json({ cancelled: true, error: code === 2 ? err.trim() : undefined });
    res.json({ path: chosen, display: displayPath(chosen), relative: chosen === R.defaultCwd ? "." : R.mode === "project" && !path.relative(R.base, chosen).startsWith("..") ? path.relative(R.base, chosen) : null });
  });
});

// Shut the server down from the UI / CLI (localhost only, so no auth): interrupts running turns, tells clients, exits.
app.post("/api/shutdown", (_req, res) => {
  res.json({ ok: true });
  console.log(t("server.shutdown"));
  broadcast({ type: "shutdown" });
  setTimeout(() => void shutdown(), 150);
});
app.get("/api/offices", (_req, res) => res.json([...offices.values()].map((o) => ({ ...officeInfo(o), employees: roster(o) }))));

// ---- office management (persisted to config.json, applied live) ----
const officesPayload = () => ({ type: "offices", multiOffice: settings.multiOffice, offices: [...offices.values()].map((o) => ({ ...officeInfo(o), employees: roster(o) })) });
function persistOffices() {
  const raw = readRawConfig(R);
  // Inside the base folder → relative; elsewhere → absolute with ~ for the home folder.
  const rel = (p: string) => { const r = path.relative(R.base, p); return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : displayPath(p); };
  raw.offices = settings.offices.map((d) => {
    const prev = (raw.offices ?? []).find((x) => officeIdOf(String(x.id ?? x.name ?? ""), "") === d.id) ?? {};
    return { ...prev, id: d.id, name: d.name, employeesDir: rel(d.employeesDir), cwd: prev.cwd && absPath(R.base, String(prev.cwd)) === d.cwd ? prev.cwd : d.cwd === R.defaultCwd ? undefined : rel(d.cwd), theme: d.theme, ...(d.extraEmployees.length ? { employees: d.extraEmployees.map(rel) } : {}) };
  });
  writeRawConfig(R, raw);
}

app.post("/api/offices", (req, res) => {
  const name = clean(req.body?.name, 60);
  if (!name) return res.status(400).json({ error: t("server.nameRoleRequired") });
  const base = path.dirname(settings.offices[0].employeesDir);
  let id = officeIdOf(name, "office");
  for (let n = 2; offices.has(id); n++) id = `${officeIdOf(name, "office")}-${n}`;
  const cwdRaw = clean(req.body?.cwd, 500);
  if (!settings.multiOffice) {
    // Convert the single office into a named first office so both live side by side.
    settings.multiOffice = true;
    const first = settings.offices[0];
    const rt = offices.get(first.id)!;
    const dir = path.join(settings.dataDir, first.id);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); for (const f of ["history", "state.json"]) { const src = path.join(settings.dataDir, f); if (fs.existsSync(src)) fs.renameSync(src, path.join(dir, f)); } }
    rt.store = new Store(dir);
  }
  const def = officeDefFromRaw(R, { id, name, employeesDir: path.join(base, id), theme: pick(req.body?.theme, THEMES) ?? "default", ...(cwdRaw ? { cwd: cwdRaw } : {}) }, settings.offices.length, settings.offices[0].cwd);
  settings.offices.push(def);
  const o = openOffice(def);
  for (const e of o.employees.values()) wire(e);
  syncAgents(o);
  persistOffices();
  broadcast(officesPayload());
  res.json(officeInfo(o));
});

app.put("/api/offices/:id", async (req, res) => {
  const o = offices.get(req.params.id);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  const name = clean(req.body?.name, 60);
  if (name) o.def.name = name;
  const theme = pick(req.body?.theme, THEMES) as Theme | undefined;
  if (theme) o.def.theme = theme;
  if (req.body?.cwd !== undefined) {
    const raw = clean(req.body.cwd, 500);
    const next = raw ? absPath(R.base, raw) : R.defaultCwd;
    const prevCwd = o.def.cwd;
    o.def.cwd = next;
    for (const e of o.employees.values()) if (e.cfg.cwd === prevCwd) { await e.applyConfig({ ...e.cfg, cwd: next }); }
  }
  syncAgents(o);
  persistOffices();
  broadcast(officesPayload());
  res.json(officeInfo(o));
});

app.delete("/api/offices/:id", async (req, res) => {
  const o = offices.get(req.params.id);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  if (o.employees.size) return res.status(409).json({ error: t("server.officeNotEmpty") });
  if (offices.size <= 1) return res.status(409).json({ error: t("server.lastOffice") });
  offices.delete(o.def.id);
  settings.offices = settings.offices.filter((d) => d.id !== o.def.id);
  persistOffices();
  broadcast(officesPayload());
  res.json({ ok: true });
});

// Office-scoped routes; also mounted at /api for the default office.
const r = express.Router({ mergeParams: true });
type OReq = Request<{ office?: string; id?: string; skill?: string }>;
const officeOf = (req: OReq) => offices.get(req.params.office ?? defaultOfficeId());
const empOf = (req: OReq) => officeOf(req)?.employees.get(req.params.id ?? "");

r.get("/employees", (req: OReq, res) => {
  const o = officeOf(req);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  res.json(roster(o));
});

r.get("/employees/:id/detail", (req: OReq, res) => {
  const o = officeOf(req), e = empOf(req);
  if (!o || !e) return res.status(404).json({ error: t("server.notFound") });
  const userMsgs = e.history.filter((m) => m.role === "user").length;
  res.json({
    ...publicInfo(e),
    officeName: o.def.name,
    cwd: e.cfg.cwd,
    officeCwd: o.def.cwd,
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
    lastRefresh: o.store.getMeta<number>(e.cfg.id, "lastRefresh") ?? null,
    stats: { messages: e.history.length, tasks: userMsgs, lastActivity: e.lastActivity || null },
    recent: e.history.slice(-30),
  });
});

r.put("/employees/:id/memory", (req: OReq, res) => {
  const e = empOf(req);
  if (!e?.cfg.memoryFile) return res.status(404).json({ error: t("server.noMemory") });
  const text = typeof req.body?.text === "string" ? req.body.text : null;
  if (text === null) return res.status(400).json({ error: t("server.textRequired") });
  fs.writeFileSync(e.cfg.memoryFile, text.endsWith("\n") ? text : text + "\n");
  res.json({ ok: true });
});

function startRefresh(o: OfficeRt, e: Employee) {
  e.send(refreshPrompt(), true);
  o.store.setMeta(e.cfg.id, "lastRefresh", Date.now());
}

r.post("/employees/:id/refresh", (req: OReq, res) => {
  const o = officeOf(req), e = empOf(req);
  if (!o || !e) return res.status(404).json({ error: t("server.notFound") });
  if (e.status === "working" || e.status === "waiting") return res.status(409).json({ error: t("server.busy") });
  startRefresh(o, e);
  res.json({ ok: true });
});

r.post("/employees/:id/reset", async (req: OReq, res) => {
  const e = empOf(req);
  if (!e) return res.status(404).json({ error: t("server.notFound") });
  await e.reset();
  res.json({ ok: true });
});

// ---- HR: hire / update / fire / skills ----
r.post("/employees", (req: OReq, res) => {
  const o = officeOf(req);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  const b = req.body ?? {};
  const name = clean(b.name, 40), role = clean(b.role, 60), prompt = clean(b.prompt, 20000);
  if (!name || !role) return res.status(400).json({ error: t("server.nameRoleRequired") });
  const look = typeof b.look === "object" && b.look ? b.look : undefined;
  const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : "#56b6c2";
  const dir = createEmployeeDir(o.def, {
    name, role, color, prompt: prompt || t("server.defaultPrompt", { name, role }),
    look: look ?? { skin: "#f1c9a5", hair: "#3b2a20", hairStyle: "short", top: color, bottom: "#2f3548", accessory: "none" },
    model: pick(b.model, MODELS), effort: pick(b.effort, EFFORTS), permissionMode: pick(b.permissionMode, PERMS),
    cwd: clean(b.cwd, 500) || undefined,
  });
  const e = new Employee(loadEmployee(dir, o.employees.size, o.def), o.store);
  e.setColleagues({ list: () => [...o.employees.values()] });
  o.employees.set(e.cfg.id, e);
  wire(e);
  syncAgents(o);
  broadcast({ type: "roster", office: o.def.id, employees: roster(o) });
  res.json(publicInfo(e));
});

r.put("/employees/:id", async (req: OReq, res) => {
  const o = officeOf(req), e = empOf(req);
  if (!o || !e) return res.status(404).json({ error: t("server.notFound") });
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
  if (b.cwd !== undefined) { const c = clean(b.cwd, 500); cfg.cwd = c ? expandHome(c) : o.def.cwd; }
  writeAgentFile(cfg);
  await e.applyConfig(cfg);
  syncAgents(o);
  broadcast({ type: "roster", office: o.def.id, employees: roster(o) });
  res.json(publicInfo(e));
});

r.delete("/employees/:id", async (req: OReq, res) => {
  const o = officeOf(req), e = empOf(req);
  if (!o || !e) return res.status(404).json({ error: t("server.notFound") });
  await e.dispose();
  o.employees.delete(e.cfg.id);
  o.store.setSession(e.cfg.id, undefined);
  o.store.deleteHistory(e.cfg.id);
  const archived = e.cfg.dir ? archiveEmployeeDir(e.cfg.dir) : null;
  syncAgents(o);
  broadcast({ type: "roster", office: o.def.id, employees: roster(o) });
  res.json({ ok: true, archived });
});

r.post("/employees/:id/skills", async (req: OReq, res) => {
  const e = empOf(req);
  if (!e?.cfg.pluginDir) return res.status(404).json({ error: t("server.notFound") });
  const name = clean(req.body?.name, 40), description = clean(req.body?.description, 300), body = clean(req.body?.body, 30000);
  if (!name || !description) return res.status(400).json({ error: t("server.skillFields") });
  const id = writeSkill(e.cfg.pluginDir, name, description, body || t("server.skillBody", { name }));
  await e.applyConfig(e.cfg);
  res.json({ ok: true, name: id });
});

r.get("/employees/:id/skills/:skill", (req: OReq, res) => {
  const e = empOf(req);
  const s = e?.cfg.pluginDir ? readSkill(e.cfg.pluginDir, req.params.skill ?? "") : null;
  if (!s) return res.status(404).json({ error: t("server.notFound") });
  res.json(s);
});

r.delete("/employees/:id/skills/:skill", async (req: OReq, res) => {
  const e = empOf(req);
  if (!e?.cfg.pluginDir) return res.status(404).json({ error: t("server.notFound") });
  deleteSkill(e.cfg.pluginDir, req.params.skill ?? "");
  await e.applyConfig(e.cfg);
  res.json({ ok: true });
});

app.use("/api/offices/:office", r);
app.use("/api", r);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(payload: unknown) {
  const data = JSON.stringify(payload);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
}

function wire(e: Employee) {
  const id = e.cfg.id, office = e.cfg.officeId;
  e.on("status", (status, reason) => broadcast({ type: "status", office, id, status, reason }));
  e.on("message", (message) => broadcast({ type: "message", office, id, message }));
  e.on("chunk", (text) => broadcast({ type: "chunk", office, id, text }));
  e.on("chunk_end", () => broadcast({ type: "chunk_end", office, id }));
  e.on("ask", (request) => broadcast({ type: "ask", office, id, request }));
  e.on("ask_done", (requestId) => broadcast({ type: "ask_done", office, id, requestId }));
  e.on("result", (res) => broadcast({ type: "result", office, id, ...res, model: e.model }));
  e.on("reset", () => {
    broadcast({ type: "history", office, id, messages: [], pending: [] });
    broadcast({ type: "result", office, id, cost: 0, durationMs: 0 });
  });
}
for (const o of offices.values()) { for (const e of o.employees.values()) wire(e); syncAgents(o); }

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "init", offices: [...offices.values()].map((o) => ({ ...officeInfo(o), employees: roster(o) })) }));
  ws.on("message", async (raw) => {
    let msg: { type: string; office?: string; id?: string; text?: string; requestId?: string; allow?: boolean; always?: boolean; answers?: Record<string, unknown> };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const o = offices.get(msg.office ?? defaultOfficeId());
    const e = o && msg.id ? o.employees.get(msg.id) : undefined;
    if (!o || !e) return;
    switch (msg.type) {
      case "open": ws.send(JSON.stringify({ type: "history", office: o.def.id, id: e.cfg.id, messages: e.history, pending: e.pendingAsks })); break;
      case "send": if (msg.text?.trim()) e.send(msg.text.trim()); break;
      case "reply": if (msg.requestId) e.reply(msg.requestId, { allow: !!msg.allow, always: !!msg.always, answers: msg.answers }); break;
      case "interrupt": await e.interrupt(); break;
      case "reset": await e.reset(); break;
      case "refresh": if (e.status === "idle" || e.status === "error") startRefresh(o, e); break;
    }
  });
});

// Self-refresh: idle employees revisit their memory and project docs every `refreshHours` (only if they worked since last time).
setInterval(() => {
  const now = Date.now();
  for (const o of offices.values()) for (const e of o.employees.values()) {
    const hours = e.cfg.refreshHours ?? 0;
    if (hours <= 0 || e.status !== "idle") continue;
    const last = o.store.getMeta<number>(e.cfg.id, "lastRefresh") ?? 0;
    if (now - last < hours * 3600e3 || e.lastActivity <= last) continue;
    startRefresh(o, e);
  }
}, 10 * 60e3);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") { console.error(t("server.portInUse", { port: settings.port })); process.exit(1); }
  throw err;
});

server.listen(settings.port, settings.host, () => {
  const url = `http://localhost:${settings.port}`;
  try { fs.mkdirSync(path.dirname(PID_FILE), { recursive: true }); fs.writeFileSync(PID_FILE, `${process.pid}\n${settings.port}\n`); } catch {}
  console.log(t("server.open", { port: settings.port }));
  if (settings.host !== "127.0.0.1") console.log(t("server.hostWarning", { host: settings.host }));
  console.log(`  ${R.mode === "global" ? "home" : "project"}: ${R.mode === "global" ? R.root : R.base}`);
  for (const o of offices.values()) {
    console.log(`  [${o.def.name}] ${o.def.employeesDir} → ${o.def.cwd}`);
    for (const e of o.employees.values()) console.log(`    - ${e.cfg.name} (${e.cfg.role})`);
  }
  if (process.env.PIXEL_OFFICE_OPEN === "1") {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref(); } catch {}
  }
});

const PID_FILE = path.join(settings.dataDir, "server.pid");
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await Promise.all([...offices.values()].flatMap((o) => [...o.employees.values()].map((e) => e.interrupt().catch(() => {}))));
  try { fs.rmSync(PID_FILE, { force: true }); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
