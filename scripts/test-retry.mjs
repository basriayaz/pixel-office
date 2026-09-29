// Retry on passing provider errors: the classifier, and a board task on Codex / Gemini that fails with 429 and then works.
// Runs against dist/ (npm run build) with fake `codex` / `gemini` programs on PATH, in a scratch home. Nothing real is called.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "po-retry-"));
process.env.PIXEL_OFFICE_HOME = home;
process.env.PIXEL_OFFICE_RETRY_MS = "200,400";
process.env.GEMINI_API_KEY = "test-key";
const bin = path.join(home, "bin");
fs.mkdirSync(bin);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

// a fake engine: fails with `error` the first FAILS times (counted in a file), then answers "ok"
const fake = (name, fail, ok) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node
if (process.argv[2] === "debug") process.exit(0); // codex's model list, not a turn
const fs = require("fs"); const f = ${JSON.stringify(path.join(home, name + ".count"))};
const n = (Number(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : 0)) + 1; fs.writeFileSync(f, String(n));
fs.appendFileSync(f + ".args", process.argv.slice(2).join(" ") + "\\n");
process.stdin.resume(); process.stdin.on("end", () => {
  const lines = n <= Number(process.env.FAILS || 0) ? ${JSON.stringify(fail)} : ${JSON.stringify(ok)};
  if (n <= Number(process.env.FAILS || 0) && process.env.FAIL_MSG) for (const l of lines) if (l.error) l.error.message = process.env.FAIL_MSG;
  for (const l of lines) console.log(JSON.stringify(l));
});
`, { mode: 0o755 });
fake("codex",
  [{ type: "thread.started", thread_id: "th-1" }, { type: "turn.failed", error: { message: "exceeded retry limit, last status: 429 Too Many Requests" } }],
  [{ type: "thread.started", thread_id: "th-1" }, { type: "item.completed", item: { type: "agent_message", text: "ok" } }, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]);
fake("gemini",
  [{ type: "init", session_id: "gs-1" }, { type: "result", status: "error", error: { message: "[429 Too Many Requests] RESOURCE_EXHAUSTED: Quota exceeded for requests per minute" } }],
  [{ type: "init", session_id: "gs-1" }, { type: "message", role: "assistant", content: "ok" }, { type: "result", status: "success", stats: { input_tokens: 1, output_tokens: 1 } }]);

const dist = path.resolve(import.meta.dirname, "..", "dist", "server");
const { isTransient } = await import(path.join(dist, "retry.js"));
const { Employee } = await import(path.join(dist, "employee.js"));
const { Store } = await import(path.join(dist, "store.js"));
const { Board } = await import(path.join(dist, "board.js"));
const { initRuntime } = await import(path.join(dist, "runtime.js"));
const { Translator, loadLocale } = await import(path.join(dist, "i18n.js"));
initRuntime({ offices: [], taskSessions: true }, new Translator(loadLocale("en").data));

// ---- classifier ----
for (const s of [
  'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  "API Error: Request timed out.", "API Error: Connection error.", "API Error: 500 Internal server error",
  "[429 Too Many Requests] RESOURCE_EXHAUSTED: Quota exceeded for requests per minute", "503 UNAVAILABLE: The model is overloaded", "TypeError: fetch failed",
  "stream disconnected before completion: error sending request", "exceeded retry limit, last status: 429 Too Many Requests", "read ECONNRESET",
]) assert.equal(isTransient(s), true, s);
for (const s of [
  "401 Unauthorized", "API key not valid. Please pass a valid API key. (API_KEY_INVALID)", "invalid_refresh_token",
  "You've hit your limit · resets 5pm", "insufficient_quota: You exceeded your current quota, please check your plan and billing details",
  "429 RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content_free_tier_requests, limit: 50 per day",
  "prompt is too long: 210000 tokens > 200000 maximum", "error_max_turns", "codex exited with 1", undefined,
]) assert.equal(isTransient(s), false, String(s));
console.log("classifier ok");

// ---- a task turn on each engine ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(engine, model, fails, expect) {
  process.env.FAILS = String(fails);
  fs.rmSync(path.join(home, engine + ".count"), { force: true });
  fs.rmSync(path.join(home, engine + ".count.args"), { force: true });
  const dir = fs.mkdtempSync(path.join(home, engine + "-"));
  const store = new Store(dir), board = new Board(dir);
  const e = new Employee({ id: "e1", officeId: "o1", name: "Test", role: "dev", color: "#fff", look: {}, systemPrompt: "-", cwd: dir, model }, store);
  e.setColleagues({ list: () => [e], board: () => board, launch: () => "started", discoveryBlock: () => undefined, autoMoveBlock: () => undefined, countDiscovery() {}, capBlock: () => undefined, mcpUrl: () => "http://127.0.0.1:1/mcp" });
  const retries = [];
  const statuses = [];
  e.on("retry", (r) => retries.push(r));
  e.on("status", (s) => statuses.push(s));
  // the office blocks a "doing" task when its owner shows "error" (index.ts)
  e.on("status", (s) => { if (s === "error") for (const k of board.tasks.filter((x) => x.status === "doing")) board.updateTask(k.id, { status: "blocked", note: "error" }, "system"); });
  const k = board.addTask("e1", "t", "d", "user");
  e.startTask(k.id);
  for (let i = 0; i < 60 && !(board.tasks[0].status === "blocked" || (retries.length >= Math.min(fails, 2) && e.status === "idle" && fs.existsSync(path.join(home, engine + ".count")) && Number(fs.readFileSync(path.join(home, engine + ".count"), "utf8")) > fails)); i++) await sleep(100);
  await sleep(200);
  const calls = Number(fs.readFileSync(path.join(home, engine + ".count"), "utf8"));
  const args = fs.readFileSync(path.join(home, engine + ".count.args"), "utf8").trim().split("\n");
  await e.dispose();
  expect({ retries, statuses, task: board.tasks[0], calls, args, history: e.history });
}

for (const [engine, model, session] of [["codex", "gpt-5", "th-1"], ["gemini", "gemini-2.5-flash", "gs-1"]]) {
  // two failures, then it works: two retries, the same session resumed, the task keeps going (never blocked)
  await run(engine, model, 2, ({ retries, statuses, task, calls, args, history }) => {
    assert.equal(calls, 3, `${engine}: 3 calls`);
    assert.deepEqual(retries.map((r) => r.attempt), [1, 2]);
    assert.equal(task.status, "doing");
    assert.ok(!statuses.includes("error"));
    assert.ok(args.slice(1).every((a) => a.includes(session)), `${engine}: retries resume ${session}`);
    assert.ok(history.some((m) => m.role === "assistant" && m.text === "ok"));
  });
  // it never works: two retries (the configured waits), then the task is blocked as before
  await run(engine, model, 99, ({ retries, statuses, task, calls }) => {
    assert.equal(calls, 3, `${engine}: 1 + 2 retries`);
    assert.equal(retries.length, 2);
    assert.ok(statuses.includes("error"));
    assert.equal(task.status, "blocked");
  });
  // an error no retry fixes: no retry, and the task is blocked with the error instead of staying "doing" with an idle owner
  process.env.FAIL_MSG = "401 Unauthorized";
  await run(engine, model, 99, ({ retries, task, calls }) => {
    assert.equal(calls, 1, `${engine}: no retry`);
    assert.equal(retries.length, 0);
    assert.equal(task.status, "blocked");
    assert.match(task.notes.at(-1).text, /401 Unauthorized/);
  });
  delete process.env.FAIL_MSG;
  console.log(`${engine} ok`);
}
fs.rmSync(home, { recursive: true, force: true });
console.log("retry tests ok");
