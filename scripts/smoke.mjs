// Starts the built server on a free port in a scratch home, checks the UI and API answer, then shuts it down.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const home = process.env.PIXEL_OFFICE_HOME || fs.mkdtempSync(path.join(os.tmpdir(), "po-smoke-"));
const port = 4700 + Math.floor(Math.random() * 200);
const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "..", "bin", "pixel-office.js"), "--global", "--no-open", "--port", String(port)], { env: { ...process.env, PIXEL_OFFICE_HOME: home, PIXEL_OFFICE_SAMPLES: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) { await sleep(500); try { ok = (await fetch(`http://127.0.0.1:${port}/api/options`)).ok; } catch {} }
  if (!ok) throw new Error("server did not answer\n" + log);
  const opts = await (await fetch(`http://127.0.0.1:${port}/api/options`)).json();
  if (!opts.locale || !Array.isArray(opts.offices)) throw new Error("bad /api/options");
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  if (!html.includes("<canvas")) throw new Error("index.html has no canvas");
  const emps = await (await fetch(`http://127.0.0.1:${port}/api/offices/${opts.offices[0].id}/employees`)).json();
  if (emps.length !== 3) throw new Error(`expected 3 sample employees, got ${emps.length}`);
  const r = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" });
  if (!r.ok) throw new Error("shutdown failed");
  await sleep(1500);
  if (child.exitCode === null) throw new Error("server still running after shutdown");
  console.log(`smoke ok (${emps.map((e) => e.name).join(", ")})`);
} catch (e) {
  console.error(e.message); child.kill(); process.exit(1);
}
