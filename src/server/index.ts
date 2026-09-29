import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFile, execFileSync } from "node:child_process";
import express, { type Request } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { Employee, listConnectors, IMAGE_TYPES, type EmployeeConfig, type ImageInput } from "./employee.js";
import { Store } from "./store.js";
import { Meeting } from "./meeting.js";
import { Board, TASK_STATUSES, IDEA_STATUSES, type TaskStatus, type Task, type IdeaStatus, type Effort } from "./board.js";
import { expandHome, ensureWorktree, loadEmployees, loadEmployee, listSkills, listProjectSkills, writeAgentFile, createEmployeeDir, archiveEmployeeDir, writeSkill, readSkill, deleteSkill, syncClaudeAgents } from "./agents.js";
import { loadSettings, ensureProjectIgnores, configPath, readRawConfig, writeRawConfig, officeDefFromRaw, officeIdOf, absPath, displayPath, rootFromEnv, initRoot, PKG_ROOT, THEMES, type OfficeDef, type Theme } from "./config.js";
import { loadLocale, availableLocales, detectLocale, Translator } from "./i18n.js";
import { initRuntime, t } from "./runtime.js";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { officeToolDefs } from "./office-tools.js";
import { CLAUDE_MODELS, PROVIDERS, activeModels, isActiveModel, initProviders, providersReady, providerStatuses, updateProvider, installProvider, loginProvider, refreshProvider, canInstall, canLogin, type ProviderId } from "./providers.js";
import { createGuard, isLoopbackHost } from "./security.js";
import { acquireLock } from "./lock.js";
import { writeFileAtomicSync } from "./fsutil.js";
import { Ledger, dayKey, type Cap } from "./ledger.js";
import { initPrices, pricesFile, customPrices, parsePrices, saveCustomPrices, DEFAULT_PRICES } from "./prices.js";
import { EventLog, type OfficeEvent } from "./events.js";
import { Progress } from "./progress.js";
import { RunLog, sessionTranscript, type RunStatus } from "./runs.js";
import { getQuota, onQuota } from "./quota.js";
import type { Spend } from "./employee.js";

const R = rootFromEnv();
// Global mode sets itself up on first run; project mode expects `pixel-office init`.
let firstRun = false;
if (!fs.existsSync(configPath(R))) {
  if (R.mode === "global") { initRoot(R, { locale: detectLocale() }); console.log(`Created ${configPath(R)}`); firstRun = true; }
  else console.log(`No ${configPath(R)} — using defaults (run "pixel-office init" to create one).`);
}
ensureProjectIgnores(R);
const settings = loadSettings(R);
let locale = loadLocale(settings.locale);
initRuntime(settings, new Translator(locale.data));
initPrices(settings.dataDir);

// No login exists, so listening beyond this machine would hand every employee's shell to the whole network.
if (!isLoopbackHost(settings.host) && process.env.PIXEL_OFFICE_ALLOW_REMOTE !== "1") {
  console.error(`Refusing to listen on ${settings.host}: the office has no login, so anyone on the network could command your employees.\n` +
    `Use host 127.0.0.1 (the default), or set PIXEL_OFFICE_ALLOW_REMOTE=1 if you really mean it.`);
  process.exit(1);
}

// One server per data folder: taken before anything below reads or moves data (see lock.ts).
const PID_FILE = path.join(settings.dataDir, "server.pid");
const lock = (() => {
  try { return acquireLock(PID_FILE, settings.port); }
  catch (err) { console.warn(`Could not create ${PID_FILE} (${(err as Error).message}); starting without the one-server-per-folder lock.`); return null; }
})();
if (lock && !lock.ok) {
  console.error(`Another Pixel Office server (pid ${lock.pid}${lock.port ? `, http://localhost:${lock.port}` : ""}) already uses ${settings.dataDir}.\n` +
    `Only one server may run per data folder. Stop it first ("pixel-office stop"), or use another PIXEL_OFFICE_HOME.`);
  process.exit(1);
}
const releaseLock = () => { if (lock?.ok) lock.release(); };
process.on("exit", releaseLock);

// ---- errors must not take the office down ----
// One bad message, route or timer used to end the process, and with it every employee's running session. Before the
// server listens, a crash is a real startup failure and still exits; afterwards it is logged and the office keeps going,
// unless errors pile up so fast that something is clearly broken for good.
let listening = false, stopping = false;
const crashTimes: number[] = [];
function logError(where: string, err: unknown) {
  console.error(`[error] ${where}:`, err instanceof Error ? err.stack ?? err.message : err);
}
function onFatal(kind: string, err: unknown) {
  logError(kind, err);
  if (!listening || stopping) { releaseLock(); process.exit(1); }
  const now = Date.now();
  crashTimes.push(now);
  while (crashTimes.length && now - crashTimes[0] > 60e3) crashTimes.shift();
  if (crashTimes.length > 20) { console.error("[error] more than 20 uncaught errors in a minute; shutting down."); void shutdown(1); }
}
process.on("unhandledRejection", (reason) => onFatal("unhandled promise rejection", reason));
process.on("uncaughtException", (err) => onFatal("uncaught exception", err));
// Wraps a callback so a throw inside it is logged instead of travelling into whoever called it (an Employee's turn loop,
// the Board's save, a timer).
const safe = <A extends unknown[]>(where: string, fn: (...a: A) => unknown) => (...a: A) => {
  try { const r = fn(...a); if (r instanceof Promise) r.catch((err) => logError(where, err)); }
  catch (err) { logError(where, err); }
};

interface OfficeRt {
  def: OfficeDef;
  store: Store;
  employees: Map<string, Employee>;
  meeting?: Meeting; // the running meeting, or the one that just ended (kept until the panel is closed)
  board: Board;      // shared notebook + task list
  ledger: Ledger;    // costs.jsonl: what every turn spent, never reset
  events: EventLog;  // events.jsonl: the activity feed
  runs: RunLog;      // runs.jsonl: one line per finished task run
  openRuns: Map<number, OpenRun>;
  progress: Progress; // progress.json: XP per employee, office unlocks, daily badge
}
const offices = new Map<string, OfficeRt>();

// ---- activity log ----
const whoName = (o: OfficeRt, id?: string) => (!id ? undefined : id === "user" ? t("server.meeting.boss") : id === "office" ? t("server.events.office") : o.employees.get(id)?.cfg.name ?? id);
function logEvent(o: OfficeRt, ev: Omit<OfficeEvent, "id" | "ts">): OfficeEvent {
  const by = ev.by === "system" ? "office" : ev.by;
  const k = ev.task !== undefined ? o.board.tasks.find((x) => x.id === ev.task) : undefined;
  const event = o.events.add({
    ...ev, by, byName: ev.byName ?? whoName(o, by),
    empName: ev.empName ?? whoName(o, ev.emp), taskTitle: ev.taskTitle ?? k?.title,
  });
  broadcast({ type: "activity", office: o.def.id, event });
  return event;
}

// ---- daily cap: stops what the office starts by itself, never what the boss starts ----
const capOf = (o: OfficeRt): Cap => ({ daily: 0, codexTokens: 0, ...(o.store.getMeta<Partial<Cap>>("_office", "cap") ?? {}) });
function capState(o: OfficeRt) {
  const c = capOf(o), today = o.ledger.today();
  const daily = c.daily > 0 && today.cost >= c.daily, codex = c.codexTokens > 0 && today.codexTokens >= c.codexTokens;
  return { daily: c.daily, codexTokens: c.codexTokens, reached: daily || codex, reason: daily ? "daily" : codex ? "codex" : null } as const;
}
const capReached = (o: OfficeRt) => capState(o).reached;
const capText = (o: OfficeRt) => { const c = capState(o); return c.reason === "codex" ? t("server.cap.codex", { limit: c.codexTokens }) : t("server.cap.daily", { limit: c.daily }); };
const costsBrief = (o: OfficeRt) => { const td = o.ledger.today(); return { today: td.cost, todayTokens: { codex: td.codexTokens }, cap: capState(o) }; };
const costsPayload = (o: OfficeRt, days: number) => ({ ...o.ledger.summary(days, (id) => o.board.tasks.find((x) => x.id === id)?.title), cap: capState(o) });
// cap_reached once per day and kind
function checkCap(o: OfficeRt) {
  const c = capOf(o), today = o.ledger.today(), day = dayKey(Date.now());
  const seen = o.store.getMeta<{ day: string; kinds: string[] }>("_office", "capNotified");
  const kinds = seen?.day === day ? [...seen.kinds] : [];
  const hit: Array<["daily" | "codex", number]> = [];
  if (c.daily > 0 && today.cost >= c.daily && !kinds.includes("daily")) hit.push(["daily", c.daily]);
  if (c.codexTokens > 0 && today.codexTokens >= c.codexTokens && !kinds.includes("codex")) hit.push(["codex", c.codexTokens]);
  if (!hit.length) return;
  o.store.setMeta("_office", "capNotified", { day, kinds: [...kinds, ...hit.map((h) => h[0])] });
  for (const [what, limit] of hit) {
    logEvent(o, { kind: "cap_reached", by: "office", data: { what, limit } });
    console.log(`[cap] [${o.def.name}] daily ${what === "daily" ? "spend" : "Codex token"} cap reached (${limit}): the office starts nothing by itself until tomorrow`);
  }
}
function recordSpend(o: OfficeRt, e: Employee, s: Spend) {
  o.ledger.add({ ts: Date.now(), emp: e.cfg.id, empName: e.cfg.name, engine: s.engine, model: s.model, kind: s.kind, ...(s.task !== undefined ? { task: s.task } : {}), cost: s.cost, ...(s.tokens ? { tokens: s.tokens } : {}) });
  if (s.task !== undefined && !o.openRuns.has(s.task)) { const k = o.board.tasks.find((x) => x.id === s.task); if (k?.status === "doing") openRun(o, k); }
  broadcast({ type: "costs", office: o.def.id, ...costsBrief(o) });
  checkCap(o);
}

// ---- task runs: from "doing" until it left "doing" and the owner's turn ended (the last turn's cost belongs to the run) ----
interface OpenRun { task: number; emp: string; startedAt: number; closing?: RunStatus }
function openRun(o: OfficeRt, k: Task) { o.openRuns.set(k.id, { task: k.id, emp: k.owner, startedAt: Date.now() }); }
function closeRun(o: OfficeRt, run: OpenRun, status: RunStatus) {
  o.openRuns.delete(run.task);
  const endedAt = Date.now(), spent = o.ledger.forTask(run.task, run.startedAt, endedAt);
  const e = o.employees.get(run.emp), k = o.board.tasks.find((x) => x.id === run.task);
  o.runs.add({ task: run.task, emp: run.emp, empName: e?.cfg.name ?? run.emp, startedAt: run.startedAt, endedAt, durationMs: endedAt - run.startedAt, cost: spent.cost, ...(spent.codexTokens ? { codexTokens: spent.codexTokens } : {}), status, ...(k?.session ? { session: k.session } : {}) });
  logEvent(o, { kind: "run_end", emp: run.emp, task: run.task, data: { status, durationMs: endedAt - run.startedAt, cost: spent.cost } });
}
// runs of this employee that already left "doing" end with the turn that is ending now
function settleRuns(o: OfficeRt, emp: string, all = false) {
  for (const run of [...o.openRuns.values()]) if (run.emp === emp && (run.closing || all)) closeRun(o, run, run.closing ?? "stopped");
}
function trackRun(o: OfficeRt, k: Task, prev: TaskStatus, by: string) {
  if (k.status === "doing") { if (!o.openRuns.has(k.id)) openRun(o, k); return; }
  const run = o.openRuns.get(k.id);
  if (!run || prev !== "doing") return;
  const last = k.notes[k.notes.length - 1]?.text;
  run.closing = k.status === "todo" && by === "user" ? "stopped" : k.status === "blocked" && last?.startsWith(t("server.board.sessionError")) ? "error" : k.status;
  if (!o.employees.get(run.emp)?.busy) closeRun(o, run, run.closing);
}

// Store folder per office: dataDir itself for a single office, dataDir/<id> once there are several.
// A single office that became one of several keeps its data at dataDir until the next start (employees, the board and
// meetings hold on to their folder, so nothing may move under them while they run); at that start, before anything is
// opened, the first office's data is moved under dataDir/<id>: chat histories, state, board, meetings and attachments.
const LEGACY_DATA = /^(history|meetings|attachments|(state|board)\.json(\.bak|\.corrupt-.+)?)$/;
const RESERVED_OFFICE_IDS = new Set(["history", "meetings", "attachments"]);
function migrateSingleOfficeData(dir: string) {
  const root = settings.dataDir;
  let entries: string[] = [];
  try { entries = fs.readdirSync(root).filter((f) => LEGACY_DATA.test(f)); } catch { return; }
  if (!entries.length) return;
  if (fs.existsSync(path.join(dir, "state.json")) || fs.existsSync(path.join(dir, "board.json"))) {
    console.warn(`[data] ${root} still has single-office data (${entries.join(", ")}), but ${dir} already has its own; leaving both untouched. Merge them by hand.`);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const f of entries) {
    const src = path.join(root, f), dst = path.join(dir, f);
    if (!fs.existsSync(dst)) { fs.renameSync(src, dst); continue; }
    // a folder the office already has (usually an empty history/ a Store created): move what it does not have yet
    if (fs.statSync(src).isDirectory() && fs.statSync(dst).isDirectory()) {
      for (const c of fs.readdirSync(src)) if (!fs.existsSync(path.join(dst, c))) fs.renameSync(path.join(src, c), path.join(dst, c));
      try { fs.rmdirSync(src); } catch { console.warn(`[data] left ${src} in place: ${dir} already had some of the same files.`); }
    } else console.warn(`[data] left ${src} in place: ${dst} already exists.`);
  }
  console.log(`[data] moved the first office's data into ${dir}`);
}
function storeFor(def: OfficeDef): Store {
  if (!settings.multiOffice) return new Store(settings.dataDir);
  const dir = path.join(settings.dataDir, def.id);
  if (def.id === settings.offices[0].id) migrateSingleOfficeData(dir);
  return new Store(dir);
}

const colleaguesOf = (o: OfficeRt) => ({
  list: () => [...o.employees.values()], board: () => o.board, launch: (k: Task, from: Employee) => launch(o, k, from),
  capBlock: () => (capReached(o) ? capText(o) : undefined),
  discoveryBlock: () => {
    if (capReached(o)) return capText(o);
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
  const prev = cycleOf(o);
  o.store.setMeta("_office", "cycle", c);
  if (c.phase === "discovering" && prev.phase !== "discovering") logEvent(o, { kind: "discovery_start", emp: managerOf(o)?.cfg.id, by: "office", data: { no: c.no } });
  else if (prev.phase === "discovering" && c.phase !== "discovering") logEvent(o, { kind: "discovery_end", emp: managerOf(o)?.cfg.id, by: "office", data: { no: prev.no } });
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
  if (!byBoss && capReached(o)) return capText(o);
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
      if (capReached(o)) return; // the findings wait on the board; the manager is not called past the cap
      wokeManager(o, t("server.events.wake.compile"));
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
  logEvent(o, { kind: "task_started", emp: k.owner, task: k.id, by, data: { by } });
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
    // a start the boss approved goes ahead; one the office approved waits past the cap
    if (w.status === "todo" && w.autoStart && w.after?.includes(k.id) && !o.board.waitingOn(w).length && (w.autoStart === "user" || !capReached(o))) launch(o, w, o.employees.get(w.autoStart));
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
  if (capReached(o)) return false; // past the daily cap the office starts nothing by itself
  const open = o.board.tasks.filter((x) => x.status !== "done");
  const running = open.some((x) => taskRunning(o, x)); // approved and queued is as good as running; a "doing" nobody works on is not
  const waiting = open.some((x) => x.status === "review" || x.status === "blocked");
  const unstarted = open.some((x) => x.status === "todo" && !x.autoStart && x.owner !== pm.cfg.id && !o.board.waitingOn(x).length);
  return mode === "auto" ? waiting || unstarted || (!running && pm.hasNews) : !running && (waiting || pm.hasNews);
}
function nudgeManager(o: OfficeRt) {
  if (!managerNeeded(o)) return;
  wokeManager(o, t(`server.events.wake.${modeOf(o)}`));
  managerOf(o)!.sendWhenFree(t(`server.board.wake.${modeOf(o)}`), () => managerNeeded(o));
}
// one line in the feed per wave, not one per nudge (identical calls collapse into one turn anyway)
const lastWoken = new Map<string, number>();
function wokeManager(o: OfficeRt, reason: string) {
  const now = Date.now();
  if (now - (lastWoken.get(o.def.id) ?? 0) < 60e3) return;
  lastWoken.set(o.def.id, now);
  logEvent(o, { kind: "pm_woken", emp: managerOf(o)?.cfg.id, by: "office", data: { reason } });
}

// ---- stuck work ----
// "doing" on the board is only a label. After a restart (shutdown keeps running tasks "doing"), a reset, or a queue that was only
// in memory, nobody works on such a task, yet it used to count as running forever: the manager was never called and no round began.
// The one answer to "is it running": its owner has it in hand (its turn, its session between turns, or its queue); an approved task
// also while it waits for its prerequisites; and a "doing" task while its owner works in the chat (task sessions off).
function taskRunning(o: OfficeRt, k: Task): boolean {
  const owner = o.employees.get(k.owner);
  if (!owner || (k.status !== "doing" && k.status !== "todo")) return false;
  if (owner.holdsTask(k.id)) return true;
  if (k.status === "todo") return !!k.autoStart && o.board.waitingOn(k).length > 0;
  return owner.busy && owner.currentTask === undefined;
}
const STUCK_TASK_MS = Number(process.env.PIXEL_OFFICE_STUCK_MS) || 5 * 60e3; // "doing", nobody holds it and its owner sits idle for this long: picked up again
const STUCK_DISCOVERY_MS = 30 * 60e3;                                       // a discovery round with nothing running in it is closed after this long
const STUCK_CHECK_MS = Number(process.env.PIXEL_OFFICE_STUCK_CHECK_MS) || 60e3; // looks at the board and the employees in memory only; never calls a model

// A "doing" task nobody works on. By hand, nothing begins by itself: it goes back to "todo" and Start continues it in its own
// session (the session stays on the task). In approved rounds and on its own, the owner continues it in that session right away.
function reviveTask(o: OfficeRt, k: Task, why: "restart" | "stuck") {
  const owner = o.employees.get(k.owner), mode = modeOf(o);
  const log = (what: string) => console.log(`[stuck] [${o.def.name}] #${k.id} "${k.title.slice(0, 60)}" (${why}, ${mode}): ${what}`);
  if (!owner) {
    o.board.updateTask(k.id, { status: "todo", note: t("server.stuck.noOwner") }, "system");
    return log(`owner ${k.owner} is gone; back to todo`);
  }
  if (mode === "manual" || capReached(o)) { // past the cap nothing is picked up again by itself either
    o.board.updateTask(k.id, { status: "todo", note: t(`server.stuck.${why}Manual`) }, "system");
    return log("back to todo; Start continues it");
  }
  const note = t(`server.stuck.${why}Resumed`);
  if (o.board.waitingOn(k).length) { // prerequisites still open: approved, it begins by itself when they are done
    o.board.updateTask(k.id, { status: "todo", note }, "system");
    return log(`waits for #${o.board.waitingOn(k).join(", #")}, then continues (${launch(o, k)})`);
  }
  o.board.updateTask(k.id, { note }, "system");
  log(`continues in its own session (${owner.startTask(k.id)})`);
}

// Once after start: nothing runs yet, so every "doing" task was left behind by the last run, and an approved task that sat in an
// owner's queue (memory only) was forgotten. Then, every minute, the same for work that got stuck while the server ran.
function reconcileAtStart(o: OfficeRt) {
  let changed = false;
  for (const k of [...o.board.tasks]) {
    if (taskRunning(o, k)) continue;
    if (k.status === "doing") { reviveTask(o, k, "restart"); changed = true; }
    else if (k.status === "todo" && k.autoStart && o.employees.has(k.owner)) {
      changed = true;
      if (modeOf(o) === "manual" || (k.autoStart !== "user" && capReached(o))) {
        o.board.markTask(k.id, { autoStart: null });
        o.board.updateTask(k.id, { note: t("server.stuck.restartQueued") }, "system");
        console.log(`[stuck] [${o.def.name}] #${k.id} "${k.title.slice(0, 60)}" (restart, manual): queued start forgotten; waits for Start`);
      } else console.log(`[stuck] [${o.def.name}] #${k.id} "${k.title.slice(0, 60)}" (restart): queued start begins again (${launch(o, k, o.employees.get(k.autoStart))})`);
    }
  }
  closeStuckDiscovery(o);
  if (changed) nudgeManager(o); // the wave these tasks held up is over: the manager hears of it once, as after any wave
}

const stuckSince = new Map<string, number>(); // office:task -> first seen "doing" with nobody on it
function checkStuck(o: OfficeRt, now = Date.now()) {
  // without task sessions a task is worked on in the chat and nobody "holds" it between turns: only the start check applies there
  if (settings.taskSessions) for (const k of [...o.board.tasks]) {
    const key = `${o.def.id}:${k.id}`;
    const owner = o.employees.get(k.owner);
    if (k.status !== "doing" || taskRunning(o, k) || owner?.busy) { stuckSince.delete(key); continue; }
    const since = stuckSince.get(key);
    if (since === undefined) { stuckSince.set(key, now); continue; }
    if (now - since < STUCK_TASK_MS) continue;
    stuckSince.delete(key);
    reviveTask(o, k, "stuck");
  }
  for (const key of stuckSince.keys()) if (key.startsWith(`${o.def.id}:`) && !o.board.tasks.some((k) => `${o.def.id}:${k.id}` === key && k.status === "doing")) stuckSince.delete(key);
  closeStuckDiscovery(o, now);
}

// A discovery round nobody works on any more (its tasks were lost, the manager's call went down with a restart) would keep the
// office in "discovering" for good, and the manager is never called then. It is closed, with a note in the notebook and a line for the manager.
function closeStuckDiscovery(o: OfficeRt, now = Date.now()) {
  const c = cycleOf(o);
  if (c.phase !== "discovering" || now - c.startedAt < STUCK_DISCOVERY_MS) return;
  if (o.board.tasks.some((k) => taskRunning(o, k)) || [...o.employees.values()].some((e) => e.busy || e.hasOfficeMessages)) return;
  const min = Math.round((now - c.startedAt) / 60e3);
  saveCycle(o, { ...c, phase: "waiting" });
  o.board.addNote("system", t("server.stuck.by"), t("server.stuck.discoveryTitle", { no: c.no }), t("server.stuck.discoveryText", { no: c.no, min }), [t("server.stuck.by")]);
  managerOf(o)?.addDigest(t("server.stuck.discoveryDigest", { no: c.no, min }));
  console.log(`[stuck] [${o.def.name}] discovery round ${c.no} closed after ${min} min with nothing running`);
  nudgeManager(o);
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
  const o: OfficeRt = { def, store, employees, board, ledger: new Ledger(store.dir), events: new EventLog(store.dir), runs: new RunLog(store.dir), openRuns: new Map(), progress: new Progress(store.dir, board.tasks) };
  offices.set(def.id, o);
  board.on("change", safe("board change", () => broadcast({ type: "board", office: def.id, board: boardPayload(o) })));
  board.on("status", safe("task status", (k: Task, _prev: TaskStatus, by: string) => onTaskStatus(o, k, by)));
  // the activity feed and the run log hear of every change to the board, whoever made it
  board.on("status", safe("task status log", (k: Task, prev: TaskStatus, by: string) => {
    const last = k.notes[k.notes.length - 1];
    const note = last && last.by === by && Date.now() - last.ts < 2000 ? last.text.replace(/\s+/g, " ").slice(0, 300) : undefined;
    logEvent(o, { kind: "task_status", emp: k.owner, task: k.id, by, data: { from: prev, to: k.status, ...(note ? { note } : {}) } });
    trackRun(o, k, prev, by);
  }));
  board.on("added", safe("task added log", (k: Task) => logEvent(o, { kind: "task_created", emp: k.owner, task: k.id, by: k.createdBy, data: {} })));
  board.on("edited", safe("task edited log", (k: Task, ch: { owner?: string; edited: boolean }, by: string) => {
    if (ch.owner !== undefined) logEvent(o, { kind: "task_owner", emp: k.owner, task: k.id, by, data: { from: ch.owner, to: k.owner, fromName: whoName(o, ch.owner), toName: whoName(o, k.owner) } });
    if (ch.edited) logEvent(o, { kind: "task_edited", emp: k.owner, task: k.id, by, data: {} });
  }));
  board.on("idea", safe("idea log", (x: { id: number; by: string; title: string }) => logEvent(o, { kind: "idea_new", emp: x.by === "user" ? undefined : x.by, idea: x.id, by: x.by, data: { title: x.title } })));
  board.on("ideaEdited", safe("idea edit log", (x: { id: number; title: string }, ed: { by: string; summary: string; fields: string[] }) => logEvent(o, { kind: "idea_edited", emp: ed.by, idea: x.id, by: ed.by, data: { title: x.title, summary: ed.summary } })));
  board.on("promoted", safe("idea promoted log", (x: { id: number; title: string }, k: Task, by: string) => logEvent(o, { kind: "idea_promoted", emp: k.owner, idea: x.id, task: k.id, by, data: { title: x.title } })));
  // finished work earns XP; a failure here never touches the work itself
  board.on("status", safe("progress", (k: Task, prev: TaskStatus) => { if (k.status === "done" && prev !== "done") o.progress.award(k); }));
  o.progress.on("change", safe("progress change", () => broadcast({ type: "progress", office: def.id, progress: o.progress.state() })));
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
// Refuses foreign pages (Origin) and DNS rebinding (Host) before anything is served; see security.ts.
initProviders(R, settings.dataDir);
const guard = createGuard({ port: settings.port, host: settings.host, extraHosts: (process.env.PIXEL_OFFICE_ALLOWED_HOSTS ?? "").split(",") });
app.use(guard.middleware);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(PKG_ROOT, "web")));

function publicInfo(e: Employee) {
  const { id, name, role, color, look, officeId } = e.cfg;
  return { id, office: officeId, name, role, color, look, engine: e.engine, status: e.status, cost: e.cost, context: e.context, task: e.currentTask ?? null, model: e.model ?? e.cfg.model ?? null, sickUntil: e.sickUntil || undefined, manager: !!e.cfg.manager, queued: e.queue.length, compacting: e.isCompacting,
    pendingAsks: e.pendingAsks, unread: unreadOf(e) };
}
// Answers of an employee the boss has not seen yet; kept in the office state so a reload does not forget them.
const unreadOf = (e: Employee) => offices.get(e.cfg.officeId)?.store.getMeta<number>(e.cfg.id, "unread") ?? 0;
function setUnread(e: Employee, n: number) {
  const o = offices.get(e.cfg.officeId);
  if (!o || unreadOf(e) === n) return false;
  o.store.setMeta(e.cfg.id, "unread", n);
  return true;
}

const readText = (p?: string) => { try { return p ? fs.readFileSync(p, "utf8") : ""; } catch { return ""; } };
const MODELS = CLAUDE_MODELS;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const PERMS = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"] as const;
const clean = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const pickModel = (v: unknown): string | undefined => pick(v, MODELS) ?? (typeof v === "string" && isActiveModel(v) ? v : undefined);
const pick = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (list as readonly string[]).includes(v as string) ? (v as T) : undefined;

const officeInfo = (o: OfficeRt) => ({ id: o.def.id, name: o.def.name, cwd: o.def.cwd, employeesDir: o.def.employeesDir, theme: o.def.theme });
const roster = (o: OfficeRt) => [...o.employees.values()].map(publicInfo);
const syncAgents = (o: OfficeRt) => syncClaudeAgents(o.def, [...o.employees.values()].map((e) => e.cfg));

// Client-side strings and options, served as a script so static pages can use them synchronously.
const clientConfig = () => ({
  locale: locale.code,
  locales: availableLocales(),
  strings: { ui: locale.data.ui, rooms: locale.data.rooms, status: locale.data.status },
  models: MODELS, extraModels: activeModels().filter((m) => m.provider !== "claude"), efforts: EFFORTS, permissions: PERMS, themes: THEMES,
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

app.get("/i18n.js", async (_req, res) => { await providersReady; res.type("application/javascript").send(`window.PO = ${JSON.stringify(clientConfig())};`); });
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

// ---- settings panel: the global switches of config.json, read and changed from the UI ----
// Only this whitelist can be changed here; port, host and the data folder are shown read-only (they need a restart).
const PKG_VERSION = (() => { try { return String(JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version ?? ""); } catch { return ""; } })();
const SETTING_KEYS = ["sickness", "compactAtTokens", "taskSessions", "refreshHours", "syncClaudeAgents"] as const;
const settingsPayload = async () => ({
  locale: locale.code, locales: availableLocales(),
  sickness: settings.sickness, compactAtTokens: settings.compactAtTokens, taskSessions: settings.taskSessions,
  refreshHours: settings.refreshHours, syncClaudeAgents: settings.syncClaudeAgents, multiOffice: settings.multiOffice,
  // an environment variable wins over config.json: the panel shows those switches locked
  envLocked: { sickness: process.env.PIXEL_OFFICE_SICKNESS === "0", compactAtTokens: process.env.PIXEL_OFFICE_COMPACT_AT !== undefined },
  server: {
    port: settings.port, host: settings.host, mode: R.mode, root: displayPath(R.mode === "global" ? R.root : R.base),
    dataDir: displayPath(settings.dataDir), configFile: displayPath(configPath(R)), version: PKG_VERSION, node: process.versions.node,
  },
});
// ---- providers (Settings → Models): which LLM engines are installed and connected, install / sign in / keys from the panel ----
const isProvider = (v: unknown): v is ProviderId => (PROVIDERS as readonly string[]).includes(String(v));
const providersPayload = async (fresh = false) => ({ providers: (await providerStatuses(fresh)).map((p) => ({ ...p, canInstall: canInstall(p.id), canLogin: canLogin(p.id) })), extraModels: activeModels().filter((m) => m.provider !== "claude") });
app.get("/api/providers", async (req, res) => res.json(await providersPayload(req.query.fresh === "1")));
app.put("/api/providers/:id", async (req, res) => {
  const id = req.params.id;
  if (!isProvider(id)) return res.status(404).json({ error: "unknown provider" });
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") return res.status(400).json({ error: t("server.settings.invalid", { key: "enabled" }) });
  if (b.apiKey !== undefined && typeof b.apiKey !== "string") return res.status(400).json({ error: t("server.settings.invalid", { key: "apiKey" }) });
  if (b.models !== undefined && !(Array.isArray(b.models) && b.models.every((m) => typeof m === "string"))) return res.status(400).json({ error: t("server.settings.invalid", { key: "models" }) });
  await updateProvider(id, { enabled: b.enabled as boolean | undefined, apiKey: b.apiKey as string | undefined, models: b.models as string[] | undefined });
  res.json(await providersPayload());
});
app.post("/api/providers/:id/install", async (req, res) => {
  const id = req.params.id;
  if (!isProvider(id) || !canInstall(id)) return res.status(404).json({ error: "unknown provider" });
  const r = await installProvider(id);
  res.json({ ...r, ...(await providersPayload()) });
});
app.post("/api/providers/:id/login", (req, res) => {
  const id = req.params.id;
  if (!isProvider(id) || !canLogin(id)) return res.status(404).json({ error: "unknown provider" });
  res.json({ ok: loginProvider(id) });
});
app.post("/api/providers/:id/check", async (req, res) => {
  const id = req.params.id;
  if (!isProvider(id)) return res.status(404).json({ error: "unknown provider" });
  await refreshProvider(id);
  res.json(await providersPayload());
});
// Token prices for Codex and Gemini turns (USD per 1M tokens). The user's rows go in front of the built-in ones, first match
// wins; PUT replaces the user's rows of the engines it names ({"codex": []} clears them).
const pricesPayload = () => ({ file: displayPath(pricesFile()), custom: customPrices(), defaults: DEFAULT_PRICES });
app.get("/api/prices", (_req, res) => res.json(pricesPayload()));
app.put("/api/prices", (req, res) => {
  let next;
  try { next = parsePrices(req.body); } catch (err) { return res.status(400).json({ error: (err as Error).message }); }
  const cur = customPrices(), b = req.body as Record<string, unknown>;
  saveCustomPrices({ codex: b.codex !== undefined ? next.codex : cur.codex, gemini: b.gemini !== undefined ? next.gemini : cur.gemini });
  res.json(pricesPayload());
});
app.get("/api/settings", async (_req, res) => res.json(await settingsPayload()));
app.put("/api/settings", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const next: Partial<Record<(typeof SETTING_KEYS)[number], boolean | number>> = {};
  for (const k of ["sickness", "taskSessions", "syncClaudeAgents"] as const) if (b[k] !== undefined) {
    if (typeof b[k] !== "boolean") return res.status(400).json({ error: t("server.settings.invalid", { key: k }) });
    next[k] = b[k];
  }
  if (b.compactAtTokens !== undefined) {
    const n = Math.round(Number(b.compactAtTokens));
    // 0 = the model's own limit; Claude Code ignores anything under 100k
    if (!Number.isFinite(n) || (n !== 0 && (n < 100000 || n > 1000000))) return res.status(400).json({ error: t("server.settings.compact") });
    next.compactAtTokens = n;
  }
  if (b.refreshHours !== undefined) {
    const n = Number(b.refreshHours);
    if (!Number.isFinite(n) || n < 1 || n > 168) return res.status(400).json({ error: t("server.settings.refresh") });
    next.refreshHours = Math.round(n * 10) / 10;
  }
  if (!Object.keys(next).length) return res.status(400).json({ error: t("server.settings.nothing") });
  const raw = readRawConfig(R);
  Object.assign(raw, next);
  writeRawConfig(R, raw);
  // applied live: getSettings() hands out this same object, so new sessions, task starts and the sickness check see it at once
  const prevRefresh = settings.refreshHours;
  if (next.sickness !== undefined && process.env.PIXEL_OFFICE_SICKNESS !== "0") settings.sickness = next.sickness as boolean;
  // switched off: whoever is ill right now gets well at once instead of sitting out the rest of their sick time
  if (!settings.sickness) for (const o of offices.values()) for (const e of o.employees.values()) if (e.sick) e.recover();
  if (next.compactAtTokens !== undefined && process.env.PIXEL_OFFICE_COMPACT_AT === undefined) settings.compactAtTokens = next.compactAtTokens as number;
  if (next.taskSessions !== undefined) settings.taskSessions = next.taskSessions as boolean;
  if (next.refreshHours !== undefined) {
    settings.refreshHours = next.refreshHours as number;
    // employees who never had a value of their own carry the old office default (agent.md leaves it out): they follow the new one
    for (const o of offices.values()) for (const e of o.employees.values()) if (e.cfg.refreshHours === prevRefresh) e.cfg.refreshHours = settings.refreshHours;
  }
  if (next.syncClaudeAgents !== undefined) {
    settings.syncClaudeAgents = next.syncClaudeAgents as boolean;
    if (settings.syncClaudeAgents) for (const o of offices.values()) safe(`agent sync of ${o.def.id}`, () => syncAgents(o))();
  }
  res.json(await settingsPayload());
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
  // office folders sit next to the first office's data until it is moved: an id must not be one of those names
  for (let n = 2; offices.has(id) || RESERVED_OFFICE_IDS.has(id); n++) id = `${officeIdOf(name, "office")}-${n}`;
  const cwdRaw = clean(req.body?.cwd, 500);
  // Converting the single office into a named first office: its data stays at dataDir for now and is moved under
  // dataDir/<id> at the next start (storeFor), because its employees, board and meeting keep writing to the folder they have.
  if (!settings.multiOffice) settings.multiOffice = true;
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
  const mode = pick(b.mode, MODES), prevMode = modeOf(o);
  if (mode) o.store.setMeta("_office", "mode", mode);
  if (mode && mode !== prevMode) logEvent(o, { kind: "mode_change", by: "user", data: { from: prevMode, to: mode } });
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
  const cur = o?.board.tasks.find((x) => x.id === Number(req.params.id));
  if (!o || !cur) return res.status(404).json({ error: t("server.notFound") });
  const owner = b.owner !== undefined ? o.employees.get(String(b.owner)) : undefined;
  if (b.owner !== undefined && !owner) return res.status(400).json({ error: t("server.board.taskFields") });
  // a running task keeps its owner: its session, turn and queue belong to them
  if (owner && owner.cfg.id !== cur.owner && (taskRunning(o, cur) || o.employees.get(cur.owner)?.currentTask === cur.id)) return res.status(409).json({ error: t("server.board.ownerRunning", { id: cur.id }) });
  if (Array.isArray(b.after)) {
    const after: number[] = b.after.map(Number).filter(Number.isFinite);
    if (after.includes(cur.id)) return res.status(400).json({ error: t("server.board.depSelf") });
    // a prerequisite that (through its own prerequisites) waits for this task would hold both up forever
    const reaches = (from: number, seen = new Set<number>()): boolean => {
      if (from === cur.id) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (o.board.tasks.find((x) => x.id === from)?.after ?? []).some((d) => reaches(d, seen));
    };
    const loop = after.find((d) => reaches(d));
    if (loop !== undefined) return res.status(400).json({ error: t("server.board.depCycle", { id: loop }) });
  }
  const k = o.board.updateTask(Number(req.params.id), {
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
  officeOf(req)!.openRuns.delete(Number(req.params.id));
  res.json({ ok: true });
});
// Past runs of a task (time, cost, how each ended) and what was said in its session.
r.get("/board/tasks/:id/runs", (req: OReq, res) => {
  const o = officeOf(req);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  res.json(o.runs.forTask(Number(req.params.id)));
});
r.get("/board/tasks/:id/transcript", async (req: OReq, res) => {
  const o = officeOf(req);
  const k = o?.board.tasks.find((x) => x.id === Number(req.params.id));
  if (!o || !k) return res.status(404).json({ error: t("server.notFound") });
  const owner = o.employees.get(k.owner);
  if (!k.session) return res.json({ available: false, reason: t("server.runs.noSession"), messages: [] });
  if (owner?.engine === "codex" || owner?.engine === "gemini" || /^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(k.session)) return res.json({ available: false, reason: t("server.runs.codex"), messages: [] });
  const messages = await sessionTranscript(k.session, owner?.cfg.cwd ?? o.def.cwd).catch(() => []);
  if (!messages.length) return res.json({ available: false, reason: t("server.runs.notFound"), messages: [] });
  res.json({ available: true, messages });
});

// ---- costs, daily cap, plan quota, activity ----
r.get("/costs", (req: OReq, res) => {
  const o = officeOf(req);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  res.json(costsPayload(o, Math.min(90, Math.max(1, Math.round(Number(req.query.days)) || 7))));
});
r.put("/costs/cap", (req: OReq, res) => {
  const o = officeOf(req), b = req.body ?? {};
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  const cap = capOf(o), num = (v: unknown, max: number) => Math.min(max, Math.max(0, Number(v) || 0));
  if (b.daily !== undefined) cap.daily = Math.round(num(b.daily, 100000) * 100) / 100;
  if (b.codexTokens !== undefined) cap.codexTokens = Math.round(num(b.codexTokens, 1e12));
  const was = capReached(o);
  o.store.setMeta("_office", "cap", cap);
  logEvent(o, { kind: "cap_changed", by: "user", data: { daily: cap.daily, codexTokens: cap.codexTokens } });
  checkCap(o);
  broadcast({ type: "costs", office: o.def.id, ...costsBrief(o) });
  // the cap was raised or switched off: what waited for it may go on
  if (was && !capReached(o)) nudgeManager(o);
  res.json(costsPayload(o, Math.min(90, Math.max(1, Math.round(Number(req.query.days)) || 7))));
});
r.get("/progress", (req: OReq, res) => {
  const o = officeOf(req);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  res.json(o.progress.state());
});
r.get("/quota", (_req, res) => res.json(getQuota()));
r.get("/activity", (req: OReq, res) => {
  const o = officeOf(req);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  const limit = Math.min(1000, Math.max(1, Math.round(Number(req.query.limit)) || 200));
  res.json({ events: o.events.since(Number(req.query.since) || 0, limit), lastSeen: o.store.getMeta<number>("_office", "lastSeen") ?? 0, now: Date.now() });
});
r.put("/activity/seen", (req: OReq, res) => {
  const o = officeOf(req);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  const ts = Math.min(Date.now(), Number(req.body?.ts) || Date.now());
  o.store.setMeta("_office", "lastSeen", Math.max(ts, o.store.getMeta<number>("_office", "lastSeen") ?? 0));
  res.json({ ok: true, lastSeen: o.store.getMeta<number>("_office", "lastSeen") });
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
  // optional `rev`: the edit is refused (409, with the idea as it is now) when somebody changed it since the client read it
  const cur = o?.board.ideas.find((x) => x.id === Number(req.params.id));
  if (cur && b.rev !== undefined && Number(b.rev) !== (cur.rev ?? 0)) return res.status(409).json({ error: t("server.ideas.changedMeanwhile", { id: cur.id }), idea: cur });
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
  const k = o.board.promoteIdea(Number(req.params.id), owner.cfg.id, "user", { review: !!b.review, commentLabel: t("server.meeting.boss") });
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

// Read-only: names of the README / text files at the top of the office's working folder (no contents, no subfolders),
// so the first-task guide knows up front whether there is a README to work from. readme = the README among them, or null.
const DOC_FILE = /\.(?:md|markdown|txt|rst|adoc)$/i;
r.get("/readme", async (req: OReq, res) => {
  const o = officeOf(req);
  if (!o) return res.status(404).json({ error: t("server.notFound") });
  const entries = await fs.promises.readdir(o.def.cwd, { withFileTypes: true }).catch(() => null);
  if (!entries) return res.json({ files: [], readme: null });
  const files = entries.filter((d) => d.isFile() && DOC_FILE.test(d.name)).map((d) => d.name)
    .sort((a, b) => a.localeCompare(b)).slice(0, 50);
  res.json({ files, readme: files.find((f) => /^readme\./i.test(f)) ?? null });
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

// Read-only diff of an employee's own worktree against the branch point of the main folder's HEAD.
r.get("/employees/:id/diff", (req: OReq, res) => {
  const e = empOf(req);
  if (!e) return res.status(404).json({ error: t("server.notFound") });
  if (!e.cfg.worktree || !e.cfg.baseCwd || e.cfg.baseCwd === e.cfg.cwd) return res.json({ enabled: false });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "--no-pager", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20_000_000 });
  const MAX = 200_000;
  try {
    const base = git(e.cfg.baseCwd, "rev-parse", "HEAD").trim();
    const mb = git(e.cfg.cwd, "merge-base", base, "HEAD").trim();
    const stat = git(e.cfg.cwd, "diff", "--no-ext-diff", "--stat", mb);
    const untracked = git(e.cfg.cwd, "ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
    let patch = git(e.cfg.cwd, "diff", "--no-ext-diff", "--no-color", mb);
    const truncated = patch.length > MAX;
    if (truncated) patch = patch.slice(0, MAX);
    res.json({ enabled: true, branch: `po/${e.cfg.id}`, stat: stat.trim(), untracked, patch, truncated });
  } catch (err) {
    res.status(500).json({ error: ((err as { stderr?: string }).stderr || (err as Error).message).toString().trim().split("\n").pop() });
  }
});

// Older chat lines moved to the archive: ?before=<ts> (default: now) &limit=<1..500> (default 200), oldest first.
// `more` says whether an older page is left.
r.get("/employees/:id/history", (req: OReq, res) => {
  const o = officeOf(req), e = empOf(req);
  if (!o || !e) return res.status(404).json({ error: t("server.notFound") });
  const before = req.query.before === undefined ? Date.now() : Number(req.query.before);
  const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  if (!Number.isFinite(before) || !Number.isInteger(limit) || limit < 1 || limit > 500) return res.status(400).json({ error: t("server.historyQuery") });
  res.json(o.store.readArchive(e.cfg.id, before, limit));
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
    autoRefresh: autoRefreshOf(e),
    lastRefresh: o.store.getMeta<number>(e.cfg.id, "lastRefresh") ?? null,
    currentManager: [...o.employees.values()].find((x) => x.cfg.manager && x !== e)?.cfg.name ?? null,
    stats: { messages: e.history.length + o.store.archiveCount(e.cfg.id), tasks: userMsgs, lastActivity: e.lastActivity || null },
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
  writeFileAtomicSync(e.cfg.memoryFile, text.endsWith("\n") ? text : text + "\n", { backup: false });
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
  logEvent(o, { kind: "hired", emp: e.cfg.id, by: "user", data: {} });
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
  // unchanged stays as it is: a model missing from today's list (Codex not signed in, a hidden model) must not be wiped by saving other settings
  if (b.model !== undefined) cfg.model = b.model && b.model === e.cfg.model ? e.cfg.model : pickModel(b.model);
  if (b.effort !== undefined) cfg.effort = pick(b.effort, EFFORTS);
  if (b.permissionMode !== undefined) cfg.permissionMode = pick(b.permissionMode, PERMS) ?? "default";
  if (b.refreshHours !== undefined) cfg.refreshHours = Math.max(0, Number(b.refreshHours) || 0);
  if (b.autoRefresh !== undefined) cfg.autoRefresh = b.autoRefresh === true || undefined;
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
  settleRuns(o, e.cfg.id, true);
  logEvent(o, { kind: "fired", emp: e.cfg.id, empName: e.cfg.name, by: "user", data: {} });
  o.store.setMeta(e.cfg.id, "unread", 0);
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

// Last stop for a route that threw (Express 5 also brings rejected async handlers here): log it, answer, keep running.
app.use((err: unknown, req: Request, res: express.Response, _next: express.NextFunction) => {
  const status = Number((err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode);
  if (!(status >= 400 && status < 500)) logError(`${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: err instanceof Error ? err.message : String(err) });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, verifyClient: (info, cb) => guard.verifyClient(info, cb) });
wss.on("error", (err) => logError("websocket server", err));

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

onQuota((quota) => broadcast({ type: "quota", quota }));

function wire(e: Employee) {
  const id = e.cfg.id, office = e.cfg.officeId;
  // a listener that throws must not break the employee's turn loop that emitted the event
  const onE = ((ev: string, fn: (...a: never[]) => unknown) => e.on(ev, safe(`${ev} of ${id}`, fn as (...a: unknown[]) => unknown))) as Employee["on"];
  onE("status", (status, reason) => broadcast({ type: "status", office, id, status, reason, sickUntil: e.sickUntil || undefined }));
  onE("message", (message) => broadcast({ type: "message", office, id, message }));
  // a session that fell over cannot be "doing" anything: its tasks show as blocked instead of looking busy forever
  onE("status", (status) => {
    if (status !== "error") return;
    const o = offices.get(office);
    for (const k of o?.board.tasks.filter((x) => x.owner === id && x.status === "doing") ?? []) o!.board.updateTask(k.id, { status: "blocked", note: t("server.board.sessionError") }, "system");
  });
  onE("chunk", (text) => broadcast({ type: "chunk", office, id, text }));
  // boss messages held until the running turn ends: the chat shows them as queued, with undo and "interrupt"
  onE("queue", (queue) => broadcast({ type: "queue", office, id, queue }));
  onE("message_removed", (msgId) => broadcast({ type: "message_removed", office, id, msgId }));
  onE("compacting", (on) => broadcast({ type: "compacting", office, id, on }));
  onE("chunk_end", () => broadcast({ type: "chunk_end", office, id }));
  onE("ask", (request) => broadcast({ type: "ask", office, id, request }));
  const oOf = () => offices.get(office);
  onE("ask", (request) => { const o = oOf(); if (o) logEvent(o, request.kind === "question"
    ? { kind: "question", emp: id, task: e.currentTask, data: { summary: askSummary(request) } }
    : { kind: "ask", emp: id, task: e.currentTask, data: { tool: request.toolName, summary: askSummary(request) } }); });
  onE("spend", (s) => { const o = oOf(); if (o) recordSpend(o, e, s); });
  onE("message", (m) => { if (m.role === "assistant" && setUnread(e, unreadOf(e) + 1)) broadcast({ type: "unread", office, id, unread: unreadOf(e) }); });
  onE("status", (status) => {
    const o = oOf();
    if (!o) return;
    if (status === "error") logEvent(o, { kind: "emp_error", emp: id, task: e.currentTask, data: { message: [...e.history].reverse().find((m) => m.role === "system")?.text.slice(0, 300) ?? "" } });
    else if (status === "sick") logEvent(o, { kind: "emp_sick", emp: id, data: {} });
    if (status !== "working" && status !== "waiting") settleRuns(o, id);
  });
  onE("retry", (r: { task: number; attempt: number; max: number; delayMs: number; message: string }) => {
    const o = oOf();
    if (o) logEvent(o, { kind: "emp_retry", emp: id, task: r.task, data: { attempt: r.attempt, max: r.max, sec: Math.round(r.delayMs / 1000), message: r.message } });
  });
  onE("result", () => { const o = oOf(); if (o) settleRuns(o, id); });
  onE("ask_done", (requestId) => broadcast({ type: "ask_done", office, id, requestId }));
  onE("result", (res) => broadcast({ type: "result", office, id, ...res, model: e.model }));
  onE("status", () => broadcast({ type: "usage", office, id, context: e.context, task: e.currentTask ?? null }));
  onE("result", () => { const o = offices.get(office); if (o) setImmediate(() => advanceCycle(o, e.cfg.manager ? { managerTurn: true } : { turnEnd: true })); });
  onE("reset", () => {
    broadcast({ type: "history", office, id, messages: [], pending: [] });
    broadcast({ type: "result", office, id, cost: 0, durationMs: 0 });
  });
}
for (const o of offices.values()) { for (const e of o.employees.values()) wire(e); syncAgents(o); }

// What a permission request is about, in one line for the feed.
function askSummary(r: { title: string; description?: string; input: Record<string, unknown> }): string {
  const qs = Array.isArray(r.input.questions) ? (r.input.questions as Array<{ question?: string }>).map((q) => q.question).filter(Boolean).join(" / ") : "";
  return (qs || r.title || r.description || "").replace(/\s+/g, " ").slice(0, 200);
}

function startMeeting(o: OfficeRt, topic: string, ids: string[], interruptBusy: boolean) {
  if (o.meeting?.active) return;
  const people = ids.map((id) => o.employees.get(id)).filter((e): e is Employee => !!e && !e.inMeeting);
  if (!people.length) return;
  const m = new Meeting(topic, people, o.store, o.def.cwd);
  o.meeting = m;
  const office = o.def.id;
  m.on("state", () => { if (o.meeting === m) broadcast({ type: "meeting", office, meeting: m.state() }); });
  m.on("entry", (entry) => { if (o.meeting === m) broadcast({ type: "meeting_entry", office, meetingId: m.id, entry }); });
  m.on("ended", safe("meeting end log", () => logEvent(o, { kind: "meeting_end", by: "user", data: { topic } })));
  m.on("cost", safe("meeting summary cost", (cost: number, model: string) => {
    o.ledger.add({ ts: Date.now(), emp: "_meeting", empName: t("server.events.meetingSummary"), engine: "claude", model, kind: "meeting", cost });
    broadcast({ type: "costs", office, ...costsBrief(o) });
    checkCap(o);
  }));
  logEvent(o, { kind: "meeting_start", by: "user", data: { topic, people: people.map((p) => p.cfg.name) } });
  void m.start(interruptBusy);
}

wss.on("connection", (ws) => {
  ws.on("error", (err) => logError("websocket client", err));
  ws.send(JSON.stringify({ type: "init", quota: getQuota(), offices: [...offices.values()].map((o) => ({ ...officeInfo(o), employees: roster(o), meeting: o.meeting?.state() ?? null, board: boardPayload(o), costs: costsBrief(o), progress: o.progress.state(), lastSeen: o.store.getMeta<number>("_office", "lastSeen") ?? 0 })) }));
  ws.on("message", async (raw) => {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    try { await handleClientMessage(ws, msg); }
    catch (err) {
      logError(`websocket message "${String(msg.type)}"`, err);
      try { ws.send(JSON.stringify({ type: "error", office: msg.office, id: msg.id, error: err instanceof Error ? err.message : String(err) })); } catch {}
    }
  });
});

interface ClientMessage {
  type: string; office?: string; id?: string; text?: string; requestId?: string; allow?: boolean; always?: boolean; answers?: Record<string, unknown>; images?: unknown;
  topic?: string; ids?: unknown; to?: unknown; interrupt?: boolean; summary?: boolean; memory?: boolean; msgId?: string; ideaId?: unknown;
}

async function handleClientMessage(ws: WebSocket, msg: ClientMessage) {
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
      case "open":
        ws.send(JSON.stringify({ type: "history", office: o.def.id, id: e.cfg.id, messages: e.history, older: o.store.hasArchive(e.cfg.id), pending: e.pendingAsks, queue: e.queue }));
        if (setUnread(e, 0)) broadcast({ type: "roster", office: o.def.id, employees: roster(o) });
        break;
      // the chat is open while answers arrive: they are seen as they come
      case "seen": if (setUnread(e, 0)) broadcast({ type: "roster", office: o.def.id, employees: roster(o) }); break;
      case "send": {
        const images = sanitizeImages(msg.images);
        // a question about an idea (asked from its card): the idea must exist; the employee gets it as it stands at delivery
        const ideaId = msg.ideaId === undefined || msg.ideaId === null ? undefined : Number(msg.ideaId);
        if (ideaId !== undefined && !o.board.ideas.some((x) => x.id === ideaId)) {
          ws.send(JSON.stringify({ type: "error", office: o.def.id, id: e.cfg.id, error: t("server.ideas.chatMissing", { id: String(msg.ideaId) }) }));
          break;
        }
        if (msg.text?.trim() || images.length) e.send((msg.text ?? "").trim(), false, images, ideaId);
        break;
      }
      case "reply": if (msg.requestId) e.reply(msg.requestId, { allow: !!msg.allow, always: !!msg.always, answers: msg.answers }); break;
      case "interrupt": await e.interrupt(); break; // Stop: the turn ends, a task it ran goes back to "todo"
      // undo a message that is still waiting; if it already went out, the client is told so (it keeps the text out of the input box)
      case "unqueue": if (typeof msg.msgId === "string" && !e.unqueue(msg.msgId)) ws.send(JSON.stringify({ type: "queue_ack", office: o.def.id, id: e.cfg.id, op: "unqueue", ok: false, msgId: msg.msgId })); break;
      // "interrupt": the running turn stops and the waiting messages go out now (not during a meeting: the queue waits for its end)
      case "deliver_now": if (!(await e.deliverNow())) ws.send(JSON.stringify({ type: "queue_ack", office: o.def.id, id: e.cfg.id, op: "deliver_now", ok: false, reason: "meeting" })); break;
      case "cure": e.recover(); break;
      case "reset": await e.reset(); break;
      case "refresh": if (e.status === "idle" || e.status === "error") startRefresh(o, e); break;
    }
}

// Self-refresh: off unless switched on per employee (`autoRefresh: true` on the profile), because it spends tokens nobody
// asked for. When on, an idle employee revisits memory and project docs every `refreshHours` (default: the office setting),
// only if they worked since last time, and never within 30 minutes of the boss writing to them.
const autoRefreshOf = (e: Employee) => e.cfg.autoRefresh === true;
const BOSS_QUIET_MS = 30 * 60e3;
setInterval(() => {
  const now = Date.now();
  for (const o of offices.values()) for (const e of o.employees.values()) safe(`auto refresh of ${e.cfg.id}`, () => {
    if (!autoRefreshOf(e) || e.status !== "idle" || capReached(o)) return;
    // nothing runs, waits or is queued, no task or meeting, and the boss has been quiet for 30 minutes
    if (!e.canAutoRefresh(BOSS_QUIET_MS, now)) return;
    const hours = (e.cfg.refreshHours ?? 0) > 0 ? e.cfg.refreshHours! : settings.refreshHours > 0 ? settings.refreshHours : 24;
    const last = o.store.getMeta<number>(e.cfg.id, "lastRefresh") ?? 0;
    if (now - last < hours * 3600e3 || e.lastActivity <= last) return;
    startRefresh(o, e);
  })();
}, 10 * 60e3);

// Now and then an idle employee catches something and rests on the sofa for a few minutes (config `sickness: false` turns it off;
// the settings panel switches it live, so the check always runs and looks at the setting each time).
const SICK_CHANCE = Number(process.env.PIXEL_OFFICE_SICK_CHANCE ?? 1 / 1000); // per employee per check → roughly once per 8 hours of idling
setInterval(safe("sickness", () => {
  if (!settings.sickness) return;
  for (const o of offices.values()) for (const e of o.employees.values()) {
    if (e.status === "idle" && Math.random() < SICK_CHANCE) e.fallIll(Math.round(3 * 60e3 + Math.random() * 2 * 60e3));
  }
}), 30e3);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") console.error(t("server.portInUse", { port: settings.port }));
  else logError("http server", err);
  if (!listening) process.exit(1); // could not start at all; the lock is released on exit
});

server.listen(settings.port, settings.host, () => {
  listening = true;
  const url = `http://localhost:${settings.port}`;
  console.log(t("server.open", { port: settings.port }));
  if (settings.host !== "127.0.0.1") console.log(t("server.hostWarning", { host: settings.host }));
  console.log(`  ${R.mode === "global" ? "home" : "project"}: ${R.mode === "global" ? R.root : R.base}`);
  for (const o of offices.values()) {
    console.log(`  [${o.def.name}] ${o.def.employeesDir} → ${o.def.cwd}`);
    for (const e of o.employees.values()) console.log(`    - ${e.cfg.name} (${e.cfg.role})`);
  }
  for (const o of offices.values()) safe(`start log of ${o.def.id}`, () => logEvent(o, { kind: "server_start", by: "office", data: {} }))();
  // work the last run left "doing" (or queued in memory) is put right before anything else starts
  for (const o of offices.values()) safe(`stuck tasks of ${o.def.id}`, () => reconcileAtStart(o))();
  setInterval(() => { for (const o of offices.values()) safe(`stuck check of ${o.def.id}`, () => checkStuck(o))(); }, STUCK_CHECK_MS).unref();
  // boss messages still queued when the office last stopped go out now, instead of waiting for some later event
  for (const o of offices.values()) for (const e of o.employees.values()) if (e.queue.length) safe(`queued messages of ${e.cfg.id}`, () => e.poke())();
  if (process.env.PIXEL_OFFICE_OPEN === "1") {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref(); } catch {}
  }
});

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  setTimeout(() => { releaseLock(); process.exit(code); }, 10e3).unref(); // an interrupt that hangs must not keep the lock forever
  // "keep": a board task that was running stays "doing" instead of falling back to "todo". At the next start reconcileAtStart finds
  // it with nobody on it: by hand it goes back to "todo" (Start continues it in its own saved session), otherwise its owner
  // continues it in that session right away.
  await Promise.all([...offices.values()].flatMap((o) => [...o.employees.values()].map((e) => e.interrupt({ task: "keep", resume: false }).catch(() => {}))));
  releaseLock();
  process.exit(code);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
