#!/usr/bin/env node
// pixel-office CLI: `pixel-office init [--locale tr] [--no-memory-git]`, `pixel-office [start] [--port N] [--dir path] [--no-open]`
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
