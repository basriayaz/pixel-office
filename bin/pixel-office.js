#!/usr/bin/env node
// pixel-office CLI: `pixel-office init [--locale tr] [--no-memory-git]`, `pixel-office [start] [--port N] [--dir path] [--no-open]`, `pixel-office stop [--dir path]`
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("-") ? args.shift() : "start";
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? def : def; };
const has = (name) => args.includes(name);
const projectDir = path.resolve(flag("--dir", process.cwd()));

if (cmd === "help" || has("--help") || has("-h")) {
  console.log(`pixel-office — a pixel-art office for your Claude agents

  pixel-office init [--locale en|tr] [--no-memory-git]   set up .pixel-office/ in this project
  pixel-office [start] [--port 4747] [--dir .] [--no-open]  start the office and open the browser
  pixel-office stop [--dir .]                             stop the office running for this project
  pixel-office help`);
  process.exit(0);
}

const dist = path.join(pkgRoot, "dist", "server");
const useDist = existsSync(path.join(dist, "index.js"));

if (cmd === "init") {
  const mod = useDist ? await import(path.join(dist, "config.js")) : await import(path.join(pkgRoot, "src", "server", "config.ts")).catch(() => null);
  if (!mod) { console.error("Build first: npm run build"); process.exit(1); }
  const res = mod.initProject(projectDir, { locale: flag("--locale", "en"), memoryInGit: !has("--no-memory-git") });
  console.log(`Created ${path.relative(projectDir, res.configFile) || res.configFile}`);
  console.log(`Employees live in ${path.relative(projectDir, res.employeesDir)}/ — copy _template to hire by hand, or use the "+ Hire" button in the office.`);
  console.log(`Start with: pixel-office`);
  process.exit(0);
}

if (cmd === "stop") {
  const mod = useDist ? await import(path.join(dist, "config.js")) : await import(path.join(pkgRoot, "src", "server", "config.ts")).catch(() => null);
  if (!mod) { console.error("Build first: npm run build"); process.exit(1); }
  const settings = mod.loadSettings(projectDir);
  const port = flag("--port", settings.port);
  const pidFile = path.join(settings.dataDir, "server.pid");
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" });
    if (res.ok) { console.log(`Stopped the office on port ${port}.`); process.exit(0); }
  } catch {}
  // Server not answering HTTP — fall back to the pid file.
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").split("\n")[0]);
    try { process.kill(pid, "SIGTERM"); console.log(`Stopped the office (pid ${pid}).`); process.exit(0); } catch {}
  }
  console.log(`No office is running on port ${port}.`);
  process.exit(0);
}

if (cmd !== "start") { console.error(`Unknown command: ${cmd}`); process.exit(1); }

const env = { ...process.env, PIXEL_OFFICE_PROJECT: projectDir };
if (flag("--port")) env.PORT = flag("--port");
if (!has("--no-open")) env.PIXEL_OFFICE_OPEN = "1";
const entry = useDist ? path.join(dist, "index.js") : null;
const child = entry
  ? spawn(process.execPath, [entry], { stdio: "inherit", env })
  : spawn(process.execPath, [path.join(pkgRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(pkgRoot, "src", "server", "index.ts")], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
