import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import express, { type Request } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { Employee, listConnectors, IMAGE_TYPES, type EmployeeConfig, type ImageInput } from "./employee.js";
import { Store } from "./store.js";
import { Meeting } from "./meeting.js";
import { Board, TASK_STATUSES, IDEA_STATUSES, type TaskStatus, type Task, type IdeaStatus, type Effort } from "./board.js";
import { expandHome, ensureWorktree, loadEmployees, loadEmployee, listSkills, listProjectSkills, writeAgentFile, createEmployeeDir, archiveEmployeeDir, writeSkill, readSkill, deleteSkill, syncClaudeAgents } from "./agents.js";
import { loadSettings, configPath, readRawConfig, writeRawConfig, officeDefFromRaw, officeIdOf, absPath, displayPath, rootFromEnv, initRoot, PKG_ROOT, THEMES, type OfficeDef, type Theme } from "./config.js";
import { loadLocale, availableLocales, detectLocale, Translator } from "./i18n.js";
import { initRuntime, t } from "./runtime.js";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { officeToolDefs } from "./office-tools.js";
import { codexModels, isCodexModel } from "./codex.js";

const R = rootFromEnv();
// Global mode sets itself up on first run; project mode expects `pixel-office init`.
let firstRun = false;
if (!fs.existsSync(configPath(R))) {
  if (R.mode === "global") { initRoot(R, { locale: detectLocale() }); console.log(`Created ${configPath(R)}`); firstRun = true; }
  else console.log(`No ${configPath(R)} — using defaults (run "pixel-office init" to create one).`);
}
const settings = loadSettings(R);
let locale = loadLocale(settings.locale);
initRuntime(settings, new Translator(locale.data));

interface OfficeRt {
  def: OfficeDef;
  store: Store;
  employees: Map<string, Employee>;
  meeting?: Meeting; // the running meeting, or the one that just ended (kept until the panel is closed)
  board: Board;      // shared notebook + task list
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

const colleaguesOf = (o: OfficeRt) => ({
  list: () => [...o.employees.values()], board: () => o.board, launch: (k: Task, from: Employee) => launch(o, k, from),
  discoveryBlock: () => {
    const c = cycleOf(o);
    if (c.phase !== "discovering") return undefined; // research the boss asked for is not counted
    if (c.tasks >= MAX_DISCOVERY_TASKS) return t("server.cycle.limit", { n: MAX_DISCOVERY_TASKS });
    return spent(o, c) > budgetOf(o) ? t("server.cycle.budget", { spent: spent(o, c).toFixed(2), budget: budgetOf(o) }) : undefined;
  },
  autoMoveBlock: () => { const c = cycleOf(o); return modeOf(o) === "auto" && c.phase !== "idle" && spent(o, c) > budgetOf(o) ? t("server.cycle.budget", { spent: spent(o, c).toFixed(2), budget: budgetOf(o) }) : undefined; },
  countDiscovery: () => { const c = cycleOf(o); if (c.phase === "discovering") saveCycle(o, { ...c, tasks: c.tasks + 1 }); },
  mcpUrl: (self: Employee) => `http://127.0.0.1:${settings.port}/mcp/${mcpToken(self)}`,
});

// Office tools for engines that run as a separate program (Codex): the same definitions Claude gets in-process, served over
// MCP streamable HTTP. One unguessable address per employee and server run, so a process can only ever act as the employee it serves.
const mcpTokens = new Map<string, Employee>();
function mcpToken(e: Employee): string {
  for (const [tok, emp] of mcpTokens) if (emp === e) return tok;
  const tok = crypto.randomBytes(24).toString("hex");
  mcpTokens.set(tok, e);
  return tok;
}

// ---- how an office works: by hand, in approved rounds, or on its own ----
// manual: nothing begins unless the boss starts it. cycle: when the board is empty a discovery round runs (research only) and its
// ideas wait for the boss. auto: the project manager also moves ideas to the board, inside the round's budget.
export const MODES = ["manual", "cycle", "auto"] as const;
type Mode = (typeof MODES)[number];
interface Cycle { phase: "idle" | "discovering" | "waiting"; no: number; startedAt: number; costAtStart: number; tasks: number; day: string; today: number }
const MAX_DISCOVERY_TASKS = 4;
const modeOf = (o: OfficeRt): Mode => o.store.getMeta<Mode>("_office", "mode") ?? "manual";
const budgetOf = (o: OfficeRt) => o.store.getMeta<number>("_office", "budget") ?? 10;
const roundsPerDay = (o: OfficeRt) => o.store.getMeta<number>("_office", "roundsPerDay") ?? 3;
const cycleOf = (o: OfficeRt): Cycle => o.store.getMeta<Cycle>("_office", "cycle") ?? { phase: "idle", no: 0, startedAt: 0, costAtStart: 0, tasks: 0, day: "", today: 0 };
const totalCost = (o: OfficeRt) => [...o.employees.values()].reduce((a, e) => a + e.cost, 0);
const spent = (o: OfficeRt, c: Cycle) => Math.max(0, totalCost(o) - c.costAtStart);
const managerOf = (o: OfficeRt) => [...o.employees.values()].find((e) => e.cfg.manager);
const quiet = (o: OfficeRt) => o.board.tasks.every((k) => k.status === "done");
const boardPayload = (o: OfficeRt) => { const c = cycleOf(o); return { ...o.board.state(), mode: modeOf(o), budget: budgetOf(o), roundsPerDay: roundsPerDay(o), cycle: { phase: c.phase, no: c.no, spent: c.phase === "idle" ? 0 : spent(o, c), tasks: c.tasks } }; };
function saveCycle(o: OfficeRt, c: Cycle) {
  o.store.setMeta("_office", "cycle", c);
  broadcast({ type: "board", office: o.def.id, board: boardPayload(o) });
}

// A discovery round: the project manager sends a few people to look around; nothing in the project is touched.
function startDiscovery(o: OfficeRt, byBoss = false): string | undefined {
  const pm = managerOf(o), c = cycleOf(o), day = new Date().toISOString().slice(0, 10);
  if (!pm) return t("server.cycle.noManager");
  if (c.phase === "discovering") return t("server.cycle.running");
  if (!quiet(o)) return t("server.cycle.notQuiet");
  const today = c.day === day ? c.today : 0;
  if (!byBoss && today >= roundsPerDay(o)) return t("server.cycle.dayLimit");
  // what already waits for the boss comes first: no new round on top of a pile of undecided ideas
  const undecided = o.board.ideas.filter((x) => x.status === "new").length;
  if (!byBoss && undecided >= 5) return t("server.cycle.undecided");
  saveCycle(o, { phase: "discovering", no: c.no + 1, startedAt: Date.now(), costAtStart: totalCost(o), tasks: 0, day, today: today + 1 });
  pm.sendWhenFree(t("server.cycle.discover", { n: MAX_DISCOVERY_TASKS, budget: budgetOf(o) }));
  return undefined;
}

// Called whenever something ended: a task changed state, or the project manager finished a turn.
function advanceCycle(o: OfficeRt, event: { task?: Task; managerTurn?: boolean; turnEnd?: boolean }) {
  const c = cycleOf(o), mode = modeOf(o);
  if (c.phase === "waiting" && event.task?.status === "doing" && event.task.kind !== "discovery") return saveCycle(o, { ...c, phase: "idle" });
  if (c.phase === "discovering" && quiet(o)) {
    const pm = managerOf(o);
    // not at the moment the last task is ticked: its owner may still be writing ideas in the same turn
    const looking = [...o.employees.values()].some((e) => e !== pm && e.busy);
    if (c.tasks > 0 && !looking && pm) {
      saveCycle(o, { ...c, phase: "waiting" });
      pm.sendWhenFree(t(mode === "auto" ? "server.cycle.compileAuto" : "server.cycle.compile", { budget: budgetOf(o), spent: spent(o, c).toFixed(2) }));
    } else if (event.managerTurn && c.tasks === 0 && pm && !pm.busy && !pm.hasOfficeMessages) saveCycle(o, { ...c, phase: "waiting" }); // the manager looked around alone and already reported
    return;
  }
  if (mode !== "manual" && c.phase === "idle" && event.task?.status === "done" && event.task.kind !== "discovery" && quiet(o)) startDiscovery(o);
}


// A start that was approved (the Start button, or the project manager's start) goes through here. With open prerequisites the
// approval is remembered on the task and it begins by itself when they are done; nothing starts that nobody approved.
function launch(o: OfficeRt, k: Task, from?: Employee): "started" | "queued" | "waiting" {
  const by = from?.cfg.id ?? "user";
  const owner = o.employees.get(k.owner);
  if (!owner || o.board.waitingOn(k).length) { o.board.markTask(k.id, { autoStart: by }); return "waiting"; }
  const r = owner.startTask(k.id, from);
  if (r === "queued") o.board.markTask(k.id, { autoStart: by });
  return r;
}

// What follows from a task changing state, without any model having to tell another one about it.
function onTaskStatus(o: OfficeRt, k: Task, by: string) {
  const owner = o.employees.get(k.owner);
  owner?.poke();
  advanceCycle(o, { task: k });
  if (k.status === "done") for (const w of o.board.tasks) {
    if (w.status === "todo" && w.autoStart && w.after?.includes(k.id) && !o.board.waitingOn(w).length) launch(o, w, o.employees.get(w.autoStart));
  }
  const pm = managerOf(o);
  if (!pm || !owner || pm === owner || (by !== k.owner && by !== "system") || !["done", "review", "blocked"].includes(k.status)) return;
  const note = k.notes[k.notes.length - 1]?.text.replace(/\s+/g, " ").slice(0, 400) ?? "";
  pm.addDigest(t("server.board.digestLine", { id: k.id, title: k.title, name: owner.cfg.name, status: k.status, note: note || "-" }));
  nudgeManager(o);
}

// The office calls the project manager when there is something for them to do. How eagerly depends on how the office works:
// by hand / approved rounds: once per wave, when nothing runs any more (the promise "the office tells the manager" is kept, at one turn per wave);
// on its own: also while others still work, whenever something waits for the manager (a review, a blocked task, approved work nobody started).
// The call waits for a free moment and identical calls collapse, so news that pile up during a manager turn cost one turn, not one each.
function managerNeeded(o: OfficeRt): boolean {
  const pm = managerOf(o), mode = modeOf(o);
  if (!pm || cycleOf(o).phase === "discovering") return false; // a discovery round has its own calls
  const open = o.board.tasks.filter((x) => x.status !== "done");
  const running = open.some((x) => x.status === "doing" || (x.status === "todo" && x.autoStart)); // approved and queued is as good as running
  const waiting = open.some((x) => x.status === "review" || x.status === "blocked");
  const unstarted = open.some((x) => x.status === "todo" && !x.autoStart && x.owner !== pm.cfg.id && !o.board.waitingOn(x).length);
  return mode === "auto" ? waiting || unstarted || (!running && pm.hasNews) : !running && (waiting || pm.hasNews);
}
function nudgeManager(o: OfficeRt) {
  if (managerNeeded(o)) managerOf(o)!.sendWhenFree(t(`server.board.wake.${modeOf(o)}`), () => managerNeeded(o));
}

function openOffice(def: OfficeDef): OfficeRt {
  if (!def.name) def.name = t("ui.offices.default");
  const store = storeFor(def);
  const employees = new Map<string, Employee>();
  let manager: string | undefined;
  for (const cfg of loadEmployees(def)) {
    if (employees.has(cfg.id)) throw new Error(t("server.duplicateId", { id: cfg.id }));
    // one project manager per office, also when agent.md files were edited by hand: the first one keeps the role
    if (cfg.manager && manager) { console.warn(t("server.board.extraManager", { name: cfg.name, manager })); cfg.manager = false; writeAgentFile(cfg); }
    else if (cfg.manager) manager = cfg.name;
    employees.set(cfg.id, new Employee(cfg, store));
  }
  const board = new Board(store.dir);
  const o: OfficeRt = { def, store, employees, board };
  offices.set(def.id, o);
  board.on("change", () => broadcast({ type: "board", office: def.id, board: boardPayload(o) }));
  board.on("status", (k: Task, _prev: TaskStatus, by: string) => onTaskStatus(o, k, by));
  for (const e of employees.values()) e.setColleagues(colleaguesOf(o));
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
  return { id, office: officeId, name, role, color, look, engine: e.engine, status: e.status, cost: e.cost, context: e.context, task: e.currentTask ?? null, model: e.model ?? e.cfg.model ?? null, sickUntil: e.sickUntil || undefined, manager: !!e.cfg.manager };
}

const readText = (p?: string) => { try { return p ? fs.readFileSync(p, "utf8") : ""; } catch { return ""; } };
const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const PERMS = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"] as const;
const clean = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const pickModel = (v: unknown): string | undefined => pick(v, MODELS) ?? (typeof v === "string" && codexModels().some((m) => m.id === v) ? v : undefined);
const pick = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (list as readonly string[]).includes(v as string) ? (v as T) : undefined;

const officeInfo = (o: OfficeRt) => ({ id: o.def.id, name: o.def.name, cwd: o.def.cwd, employeesDir: o.def.employeesDir, theme: o.def.theme });
const roster = (o: OfficeRt) => [...o.employees.values()].map(publicInfo);
const syncAgents = (o: OfficeRt) => syncClaudeAgents(o.def, [...o.employees.values()].map((e) => e.cfg));

// Client-side strings and options, served as a script so static pages can use them synchronously.
const clientConfig = () => ({
  locale: locale.code,
  locales: availableLocales(),
  strings: { ui: locale.data.ui, rooms: locale.data.rooms, status: locale.data.status },
  models: MODELS, codexModels: codexModels(), efforts: EFFORTS, permissions: PERMS, themes: THEMES,
  project: R.defaultCwd, projectDisplay: displayPath(R.defaultCwd), mode: R.mode, root: R.root, firstRun, memoryFile: settings.memoryFile, multiOffice: settings.multiOffice, defaultOffice: defaultOfficeId(),
  offices: [...offices.values()].map(officeInfo),
});
app.all("/mcp/:token", async (req, res) => {
  const e = mcpTokens.get(String(req.params.token));
  const o = e && offices.get(e.cfg.officeId);
  if (!e || !o || o.employees.get(e.cfg.id) !== e) { res.status(404).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }); return; }
  const server = new McpServer({ name: "office", version: "1.0.0" }, { instructions: t("server.office.instructions") });
  for (const d of officeToolDefs(e, colleaguesOf(o))) server.registerTool(d.name, { description: d.description, inputSchema: d.inputSchema }, d.handler as never);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless: every request stands alone
  res.on("close", () => { void transport.close(); void server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch (err) { if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: (err as Error).message }, id: null }); }
});

app.get("/i18n.js", (_req, res) => { res.type("application/javascript").send(`window.PO = ${JSON.stringify(clientConfig())};`); });
app.get("/api/options", (_req, res) => res.json(clientConfig()));
// Images pasted into a chat, stored per office and employee.
app.get("/attachments/:office/:emp/:file", (req, res) => {
  const o = offices.get(String(req.params.office));
  const p = o?.store.attachmentPath(String(req.params.emp), String(req.params.file));
  if (!p) { res.status(404).end(); return; }
  res.sendFile(p);
});

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

// Switch the UI + prompt language live. Idle employees get the new prompt on their next message; busy ones on reset.
app.put("/api/locale", async (req, res) => {
  const code = String(req.body?.locale ?? "");
  if (!availableLocales().some((l) => l.code === code)) return res.status(400).json({ error: t("server.notFound") });
  const raw = readRawConfig(R); raw.locale = code; writeRawConfig(R, raw);
  settings.locale = code;
  locale = loadLocale(code);
  initRuntime(settings, new Translator(locale.data));
  const defaultNames = new Set(availableLocales().map((l) => String((loadLocale(l.code).data.ui as { offices?: { default?: string } }).offices?.default ?? "")));
  for (const o of offices.values()) {
    if (defaultNames.has(o.def.name)) o.def.name = t("ui.offices.default"); // unnamed single office follows the language
    for (const e of o.employees.values()) if (e.status === "idle") await e.applyConfig(e.cfg).catch(() => {});
  }
  broadcast({ type: "reload" });
  res.json({ ok: true, locale: code });
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

// Shared board: the notebook and the task list. The boss edits both from the panel; employees through their office tools.
r.get("/board", (req: OReq, res) => {
  const o = officeOf(req);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  res.json(boardPayload(o));
});
// How the office works (manual / cycle / auto), the budget of one round, and a discovery round on demand.
r.put("/board/mode", (req: OReq, res) => {
  const o = officeOf(req), b = req.body ?? {};
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  const mode = pick(b.mode, MODES);
  if (mode) o.store.setMeta("_office", "mode", mode);
  if (b.budget !== undefined) o.store.setMeta("_office", "budget", Math.min(500, Math.max(1, Number(b.budget) || 10)));
  if (b.roundsPerDay !== undefined) o.store.setMeta("_office", "roundsPerDay", Math.min(24, Math.max(1, Math.round(Number(b.roundsPerDay)) || 3)));
  if (mode === "manual") { const c = cycleOf(o); if (c.phase !== "idle") o.store.setMeta("_office", "cycle", { ...c, phase: "idle" }); }
  // switched to "on its own" with work lying around: the manager picks it up now, not at the next accident
  if (mode === "auto" && o.board.tasks.some((x) => x.status !== "done")) nudgeManager(o);
  else if (mode && mode !== "manual" && quiet(o) && o.board.tasks.length) startDiscovery(o);
  broadcast({ type: "board", office: o.def.id, board: boardPayload(o) });
  res.json(boardPayload(o));
});
r.post("/board/discover", (req: OReq, res) => {
  const o = officeOf(req);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  const no = startDiscovery(o, true);
  if (no) return res.status(409).json({ error: no });
  res.json({ ok: true });
});
r.post("/board/tasks", (req: OReq, res) => {
  const o = officeOf(req), b = req.body ?? {};
  const owner = o?.employees.get(String(b.owner ?? ""));
  const title = clean(b.title, 160);
  if (!o || !owner || !title) return res.status(400).json({ error: t("server.board.taskFields") });
  // only listed: the owner starts when the boss (or the project manager) says so
  res.json(o.board.addTask(owner.cfg.id, title, clean(b.detail, 8000), "user", !!b.review, Array.isArray(b.after) ? b.after.map(Number).filter(Number.isFinite) : []));
  if (modeOf(o) === "auto") nudgeManager(o); // in an office that runs on its own, a task the boss lists is a task to get going
});
// "Start": the task goes to its owner as an ordinary message from the boss, so it shows in the chat and can be answered.
r.post("/board/tasks/:id/start", (req: OReq, res) => {
  const o = officeOf(req);
  const k = o?.board.tasks.find((x) => x.id === Number(req.params.id));
  const owner = k && o?.employees.get(k.owner);
  if (!o || !k || !owner) return res.status(404).json({ error: t("server.notFound") });
  if (owner.inMeeting) return res.status(409).json({ error: t("server.board.inMeeting", { id: k.id, name: owner.cfg.name }) });
  res.json({ ...k, launch: launch(o, k) });
});
r.put("/board/tasks/:id", (req: OReq, res) => {
  const o = officeOf(req), b = req.body ?? {};
  const owner = b.owner !== undefined ? o?.employees.get(String(b.owner)) : undefined;
  const k = o?.board.updateTask(Number(req.params.id), {
    status: pick(b.status, TASK_STATUSES) as TaskStatus | undefined, owner: owner?.cfg.id,
    title: b.title !== undefined ? clean(b.title, 160) : undefined, detail: b.detail !== undefined ? clean(b.detail, 8000) : undefined, note: clean(b.note, 2000) || undefined,
    review: b.review !== undefined ? !!b.review : undefined,
    after: Array.isArray(b.after) ? b.after.map(Number).filter(Number.isFinite) : undefined,
  }, "user");
  if (!k) return res.status(404).json({ error: t("server.notFound") });
  res.json(k);
});
// "Do your open tasks": one message instead of one per task; the owner works through them in order and marks each.
r.post("/board/start-all", (req: OReq, res) => {
  const o = officeOf(req);
  const owner = o?.employees.get(String(req.body?.owner ?? ""));
  if (!o || !owner) return res.status(404).json({ error: t("server.notFound") });
  if (owner.inMeeting) return res.status(409).json({ error: t("server.board.inMeeting", { id: "", name: owner.cfg.name }) });
  // each open task in a clean session of its own, one after the other, prerequisites respected
  const open = o.board.tasks.filter((k) => k.owner === owner.cfg.id && (k.status === "todo" || k.status === "blocked"));
  if (settings.taskSessions) for (const k of open) launch(o, k);
  else owner.send(t("server.board.doOpenTasks"));
  res.json({ ok: true, tasks: open.length });
});
r.delete("/board/tasks/:id", (req: OReq, res) => {
  if (!officeOf(req)?.board.deleteTask(Number(req.params.id))) return res.status(404).json({ error: t("server.notFound") });
  res.json({ ok: true });
});
// Ideas: suggestions from employees (and the boss). Moving one to the board makes it a task; it never starts by that alone.
const effortOf = (v: unknown) => (["S", "M", "L"].includes(String(v)) ? (String(v) as Effort) : undefined);
r.post("/board/ideas", (req: OReq, res) => {
  const o = officeOf(req), b = req.body ?? {};
  const title = clean(b.title, 160);
  if (!o || !title) return res.status(400).json({ error: t("server.board.noteFields") });
  res.json(o.board.addIdea("user", t("server.meeting.boss"), { title, text: clean(b.text, 4000), effort: effortOf(b.effort), owner: o.employees.get(String(b.owner ?? ""))?.cfg.id, tags: Array.isArray(b.tags) ? b.tags.map(String) : [] }));
});
r.put("/board/ideas/:id", (req: OReq, res) => {
  const o = officeOf(req), b = req.body ?? {};
  const idea = o?.board.updateIdea(Number(req.params.id), {
    title: b.title !== undefined ? clean(b.title, 160) : undefined, text: b.text !== undefined ? clean(b.text, 4000) : undefined,
    effort: b.effort !== undefined ? effortOf(b.effort) ?? null : undefined,
    owner: b.owner !== undefined ? o.employees.get(String(b.owner))?.cfg.id ?? null : undefined,
    status: pick(b.status, IDEA_STATUSES) as IdeaStatus | undefined, comment: b.comment !== undefined ? clean(b.comment, 600) : undefined,
  });
  if (!idea) return res.status(404).json({ error: t("server.notFound") });
  res.json(idea);
});
r.delete("/board/ideas/:id", (req: OReq, res) => {
  if (!officeOf(req)?.board.deleteIdea(Number(req.params.id))) return res.status(404).json({ error: t("server.notFound") });
  res.json({ ok: true });
});
r.post("/board/ideas/:id/promote", (req: OReq, res) => {
  const o = officeOf(req), b = req.body ?? {};
  const owner = o?.employees.get(String(b.owner ?? ""));
  if (!o || !owner) return res.status(400).json({ error: t("server.board.taskFields") });
  const k = o.board.promoteIdea(Number(req.params.id), owner.cfg.id, "user", { review: !!b.review });
  if (!k) return res.status(404).json({ error: t("server.notFound") });
  res.json({ ...k, launch: b.start ? launch(o, k) : null });
  if (!b.start && modeOf(o) === "auto") nudgeManager(o);
});

r.post("/board/notes", (req: OReq, res) => {
  const o = officeOf(req), b = req.body ?? {};
  const title = clean(b.title, 140), text = clean(b.text, 12000);
  if (!o || !title || !text) return res.status(400).json({ error: t("server.board.noteFields") });
  res.json(o.board.addNote("user", t("server.meeting.boss"), title, text, Array.isArray(b.tags) ? b.tags.map(String) : []));
});
r.put("/board/notes/:id", (req: OReq, res) => {
  const b = req.body ?? {};
  const n = officeOf(req)?.board.updateNote(Number(req.params.id), { title: b.title !== undefined ? clean(b.title, 140) : undefined, text: b.text !== undefined ? clean(b.text, 12000) : undefined, tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined });
  if (!n) return res.status(404).json({ error: t("server.notFound") });
  res.json(n);
});
r.delete("/board/notes/:id", (req: OReq, res) => {
  if (!officeOf(req)?.board.deleteNote(Number(req.params.id))) return res.status(404).json({ error: t("server.notFound") });
  res.json({ ok: true });
});

// Past meetings of an office (newest first) and one transcript.
r.get("/meetings", (req: OReq, res) => {
  const o = officeOf(req);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  res.json(o.store.listMeetings());
});
r.get("/meetings/:id", (req: OReq, res) => {
  const m = officeOf(req)?.store.loadMeeting(String(req.params.id));
  if (!m) return res.status(404).json({ error: t("server.notFound") });
  res.json(m);
});

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
    cwd: e.cfg.baseCwd ?? e.cfg.cwd,
    workdir: e.cfg.cwd,
    worktree: !!e.cfg.worktree,
    branch: e.cfg.worktree ? `po/${e.cfg.id}` : null,
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
    projectSkills: listProjectSkills(e.cfg.cwd).map((s) => ({ ...s, dir: displayPath(s.dir) })),
    connectorsOff: e.cfg.connectorsOff ?? [],
    skillsDir: e.cfg.pluginDir ? path.join(e.cfg.pluginDir, "skills") : null,
    refreshHours: e.cfg.refreshHours ?? 0,
    lastRefresh: o.store.getMeta<number>(e.cfg.id, "lastRefresh") ?? null,
    currentManager: [...o.employees.values()].find((x) => x.cfg.manager && x !== e)?.cfg.name ?? null,
    stats: { messages: e.history.length, tasks: userMsgs, lastActivity: e.lastActivity || null },
    recent: e.history.slice(-30),
  });
});

// claude.ai connectors of the account: every employee gets them unless switched off on their profile.
r.get("/connectors", async (req: OReq, res) => {
  const o = officeOf(req);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  res.json(await listConnectors(o.def.cwd, req.query.fresh === "1"));
});
r.put("/employees/:id/connectors", (req: OReq, res) => {
  const e = empOf(req);
  if (!e) return res.status(404).json({ error: t("server.notFound") });
  const off = Array.isArray(req.body?.off) ? [...new Set((req.body.off as unknown[]).map((x) => clean(x, 80).replace(/,/g, "")).filter(Boolean))].slice(0, 100) : [];
  const cfg: EmployeeConfig = { ...e.cfg, connectorsOff: off.length ? off : undefined };
  writeAgentFile(cfg);
  e.setConfigQuietly(cfg);
  res.json({ ok: true, off, applies: e.busy ? "next" : "now" });
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
  if (e.refresh()) o.store.setMeta(e.cfg.id, "lastRefresh", Date.now());
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
    model: pickModel(b.model), effort: pick(b.effort, EFFORTS), permissionMode: pick(b.permissionMode, PERMS),
    cwd: clean(b.cwd, 500) || undefined,
  });
  const e = new Employee(loadEmployee(dir, o.employees.size, o.def), o.store);
  e.setColleagues(colleaguesOf(o));
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
  if (b.model !== undefined) cfg.model = pickModel(b.model);
  if (b.effort !== undefined) cfg.effort = pick(b.effort, EFFORTS);
  if (b.permissionMode !== undefined) cfg.permissionMode = pick(b.permissionMode, PERMS) ?? "default";
  if (b.refreshHours !== undefined) cfg.refreshHours = Math.max(0, Number(b.refreshHours) || 0);
  if (b.cwd !== undefined) { const c = clean(b.cwd, 500); cfg.baseCwd = c ? expandHome(c) : o.def.cwd; }
  if (b.worktree !== undefined) cfg.worktree = !!b.worktree;
  if (b.cwd !== undefined || b.worktree !== undefined) {
    const base = cfg.baseCwd ?? cfg.cwd;
    if (cfg.worktree) {
      const w = ensureWorktree(base, cfg.id);
      if (!w.path) return res.status(400).json({ error: w.error });
      cfg.cwd = w.path;
    } else cfg.cwd = base;
  }
  if (b.manager !== undefined) cfg.manager = !!b.manager;
  // one project manager per office: appointing a new one relieves the previous
  if (cfg.manager && !e.cfg.manager) for (const other of o.employees.values()) if (other !== e && other.cfg.manager) { const oc = { ...other.cfg, manager: false }; writeAgentFile(oc); await other.applyConfig(oc); }
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
  // their unfinished tasks stay on the board, flagged so somebody else gets them
  for (const k of o.board.tasks.filter((x) => x.owner === e.cfg.id && x.status !== "done")) o.board.updateTask(k.id, { status: "blocked", note: t("server.board.ownerLeft", { name: e.cfg.name }) }, "system");
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

// Keeps only well-formed image blocks of a supported type; at most 10 images and ~20 MB of base64 per message.
function sanitizeImages(raw: unknown): ImageInput[] {
  if (!Array.isArray(raw)) return [];
  const out: ImageInput[] = [];
  let total = 0;
  for (const im of raw.slice(0, 10)) {
    if (!im || typeof im !== "object") continue;
    const { media_type, data } = im as Record<string, unknown>;
    if (typeof media_type !== "string" || !IMAGE_TYPES.has(media_type) || typeof data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(data)) continue;
    total += data.length;
    if (total > 20 * 1024 * 1024) break;
    out.push({ media_type: media_type as ImageInput["media_type"], data });
  }
  return out;
}

function broadcast(payload: unknown) {
  const data = JSON.stringify(payload);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
}

function wire(e: Employee) {
  const id = e.cfg.id, office = e.cfg.officeId;
  e.on("status", (status, reason) => broadcast({ type: "status", office, id, status, reason, sickUntil: e.sickUntil || undefined }));
  e.on("message", (message) => broadcast({ type: "message", office, id, message }));
  // a session that fell over cannot be "doing" anything: its tasks show as blocked instead of looking busy forever
  e.on("status", (status) => {
    if (status !== "error") return;
    const o = offices.get(office);
    for (const k of o?.board.tasks.filter((x) => x.owner === id && x.status === "doing") ?? []) o!.board.updateTask(k.id, { status: "blocked", note: t("server.board.sessionError") }, "system");
  });
  e.on("chunk", (text) => broadcast({ type: "chunk", office, id, text }));
  e.on("chunk_end", () => broadcast({ type: "chunk_end", office, id }));
  e.on("ask", (request) => broadcast({ type: "ask", office, id, request }));
  e.on("ask_done", (requestId) => broadcast({ type: "ask_done", office, id, requestId }));
  e.on("result", (res) => broadcast({ type: "result", office, id, ...res, model: e.model }));
  e.on("status", () => broadcast({ type: "usage", office, id, context: e.context, task: e.currentTask ?? null }));
  e.on("result", () => { const o = offices.get(office); if (o) setImmediate(() => advanceCycle(o, e.cfg.manager ? { managerTurn: true } : { turnEnd: true })); });
  e.on("reset", () => {
    broadcast({ type: "history", office, id, messages: [], pending: [] });
    broadcast({ type: "result", office, id, cost: 0, durationMs: 0 });
  });
}
for (const o of offices.values()) { for (const e of o.employees.values()) wire(e); syncAgents(o); }

function startMeeting(o: OfficeRt, topic: string, ids: string[], interruptBusy: boolean) {
  if (o.meeting?.active) return;
  const people = ids.map((id) => o.employees.get(id)).filter((e): e is Employee => !!e && !e.inMeeting);
  if (!people.length) return;
  const m = new Meeting(topic, people, o.store, o.def.cwd);
  o.meeting = m;
  const office = o.def.id;
  m.on("state", () => { if (o.meeting === m) broadcast({ type: "meeting", office, meeting: m.state() }); });
  m.on("entry", (entry) => { if (o.meeting === m) broadcast({ type: "meeting_entry", office, meetingId: m.id, entry }); });
  void m.start(interruptBusy);
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "init", offices: [...offices.values()].map((o) => ({ ...officeInfo(o), employees: roster(o), meeting: o.meeting?.state() ?? null, board: boardPayload(o) })) }));
  ws.on("message", async (raw) => {
    let msg: { type: string; office?: string; id?: string; text?: string; requestId?: string; allow?: boolean; always?: boolean; answers?: Record<string, unknown>; images?: unknown;
      topic?: string; ids?: unknown; to?: unknown; interrupt?: boolean; summary?: boolean; memory?: boolean };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const o = offices.get(msg.office ?? defaultOfficeId());
    if (!o) return;
    const idList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : []);
    switch (msg.type) {
      case "meeting_start": startMeeting(o, clean(msg.topic, 120), idList(msg.ids), !!msg.interrupt); return;
      case "meeting_say": {
        const images = sanitizeImages(msg.images);
        const text = (msg.text ?? "").trim().slice(0, 8000);
        if (!o.meeting?.active || (!text && !images.length)) return;
        const urls = images.map((im) => `/attachments/${encodeURIComponent(o.def.id)}/_meeting/${o.store.saveAttachment("_meeting", Buffer.from(im.data, "base64"), im.media_type.split("/")[1].replace("jpeg", "jpg"))}`);
        o.meeting.say(text, images, urls, idList(msg.to));
        return;
      }
      case "meeting_grant": if (msg.id) o.meeting?.grant(msg.id); return;
      case "meeting_dismiss": if (msg.id) o.meeting?.dismissHand(msg.id); return;
      case "meeting_end": await o.meeting?.end({ summary: msg.summary !== false, memory: !!msg.memory }); return;
      case "meeting_close": if (o.meeting && !o.meeting.active && !o.meeting.summarizing) { o.meeting = undefined; broadcast({ type: "meeting", office: o.def.id, meeting: null }); } return;
    }
    const e = msg.id ? o.employees.get(msg.id) : undefined;
    if (!e) return;
    switch (msg.type) {
      case "open": ws.send(JSON.stringify({ type: "history", office: o.def.id, id: e.cfg.id, messages: e.history, pending: e.pendingAsks })); break;
      case "send": {
        const images = sanitizeImages(msg.images);
        if (msg.text?.trim() || images.length) e.send((msg.text ?? "").trim(), false, images);
        break;
      }
      case "reply": if (msg.requestId) e.reply(msg.requestId, { allow: !!msg.allow, always: !!msg.always, answers: msg.answers }); break;
      case "interrupt": await e.interrupt(); break;
      case "cure": e.recover(); break;
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
    if (hours <= 0 || e.status !== "idle" || e.inMeeting) continue;
    const last = o.store.getMeta<number>(e.cfg.id, "lastRefresh") ?? 0;
    if (now - last < hours * 3600e3 || e.lastActivity <= last) continue;
    startRefresh(o, e);
  }
}, 10 * 60e3);

// Now and then an idle employee catches something and rests on the sofa for a few minutes (config `sickness: false` turns it off).
const SICK_CHANCE = Number(process.env.PIXEL_OFFICE_SICK_CHANCE ?? 1 / 1000); // per employee per check → roughly once per 8 hours of idling
if (settings.sickness) setInterval(() => {
  for (const o of offices.values()) for (const e of o.employees.values()) {
    if (e.status === "idle" && Math.random() < SICK_CHANCE) e.fallIll(Math.round(3 * 60e3 + Math.random() * 2 * 60e3));
  }
}, 30e3);

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
