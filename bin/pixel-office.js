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
const dist = path.join(pkgRoot, "dist", "server");
const useDist = existsSync(path.join(dist, "index.js"));
const cfgMod = useDist ? await import(path.join(dist, "config.js")) : await import(path.join(pkgRoot, "src", "server", "config.ts")).catch(() => null);
if (!cfgMod) { console.error("Build first: npm run build"); process.exit(1); }
// Where files live: --dir <project> or an `init`ed current folder → project mode; otherwise ~/.pixel-office (global).
const R = cfgMod.resolveRoot({ dir: flag("--dir"), global: has("--global") || cmd === "start" && has("-g") });

if (cmd === "help" || has("--help") || has("-h")) {
  console.log(`pixel-office — a pixel-art office for your Claude agents

  pixel-office                      start your office (~/.pixel-office) and open the browser
  pixel-office stop                 stop it
  pixel-office init [--locale tr]   keep employees inside THIS project instead (.pixel-office/), shared via git
  pixel-office --dir <project>      start the office of a specific project

  options: --port 4747  --no-open  --global (ignore the current project)  --no-memory-git (with init)
  files:   ~/.pixel-office/  or  <project>/.pixel-office/  (config.json, employees/, data/)`);
  process.exit(0);
}

if (cmd === "init") {
  // `init` without --global always targets the current (or --dir) project.
  const target = has("--global") ? cfgMod.globalRoot() : cfgMod.projectRoot(flag("--dir", process.cwd()));
  const res = cfgMod.initRoot(target, { locale: flag("--locale", "en"), memoryInGit: !has("--no-memory-git") });
  console.log(`Created ${res.configFile}`);
  console.log(`Employees live in ${res.employeesDir}/ — use the "+ Hire" button in the office, or copy _template by hand.`);
  console.log(`Start with: pixel-office${target.mode === "project" ? "" : " --global"}`);
  process.exit(0);
}

if (cmd === "stop") {
  const settings = cfgMod.loadSettings(R);
  const pidFile = path.join(settings.dataDir, "server.pid");
  const lockMod = useDist ? await import(path.join(dist, "lock.js")) : await import(path.join(pkgRoot, "src", "server", "lock.ts"));
  const held = lockMod.readLock(pidFile);
  const heldIsServer = !!held && lockMod.isLockHolder(held);
  // the port asked for; without --port the configured one, then the one this folder's server wrote into its lock (only if
  // it is still that server: it may run on another PORT than the config says)
  const ports = flag("--port") ? [Number(flag("--port"))] : [...new Set([settings.port, heldIsServer ? held.port : null].filter(Boolean).map(Number))];
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" });
      if (res.ok) { console.log(`Stopped the office on port ${port}.`); process.exit(0); }
    } catch {}
  }
  // Server not answering HTTP: fall back to the pid file, but only if that pid is still the server that wrote it.
  // After a crash or a reboot the pid may belong to any other program, which must never be sent a signal.
  // (Windows has no ps to prove that, so there the pid file is never used to stop anything)
  if (held && !heldIsServer) console.log(`${pidFile} is stale: pid ${held.pid} is not a Pixel Office server any more. Nothing was stopped.`);
  else if (held && process.platform !== "win32") {
    try { process.kill(held.pid, "SIGTERM"); console.log(`Stopped the office (pid ${held.pid}).`); process.exit(0); } catch {}
  }
  console.log(`No office is running on port ${ports.join(" / ")}.`);
  process.exit(0);
}

if (cmd !== "start") { console.error(`Unknown command: ${cmd}`); process.exit(1); }

const env = { ...process.env, ...cfgMod.rootToEnv(R) };
if (flag("--port")) env.PORT = flag("--port");
if (!has("--no-open")) env.PIXEL_OFFICE_OPEN = "1";
const entry = useDist ? path.join(dist, "index.js") : null;
const child = entry
  ? spawn(process.execPath, [entry], { stdio: "inherit", env })
  : spawn(process.execPath, [path.join(pkgRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(pkgRoot, "src", "server", "index.ts")], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
