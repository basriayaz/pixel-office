// The "current state" block (src/server/digest.ts): facts from the board and git, and "unavailable" lines instead of errors.
// Runs against dist/ (npm run build), in scratch folders. No network: origin/main is a local ref.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildDigest, gitFacts, statusDigest } = await import(path.join(root, "dist/server/digest.js"));

// a translator over the real locale file, so missing keys show up
const locale = (code) => JSON.parse(fs.readFileSync(path.join(root, "locales", code + ".json"), "utf8"));
const trOf = (data) => (key, vars = {}) => {
  const v = key.split(".").reduce((o, k) => o?.[k], data);
  assert.equal(typeof v, "string", `missing locale key ${key}`);
  return v.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
};

// not a git repository, no board: every such line says "unavailable", nothing throws
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "po-digest-"));
const none = gitFacts(empty);
assert.deepEqual(none, {});
for (const code of ["en", "tr"]) {
  const data = locale(code);
  const text = buildDigest({ now: Date.now(), git: none, started: Date.now() }, trOf(data));
  const na = data.server.digest.na;
  assert.ok(text.split("\n").length <= 12, "short");
  assert.equal(text.split("\n").filter((l) => l.includes(na)).length, 5, code + ": board, tree, commit, push, live unavailable");
  assert.ok(text.endsWith(data.server.digest.rule));
}
assert.equal(statusDigest(path.join(empty, "missing")), "", "runtime not set up / bad folder: empty, no throw");

// a real repository: one commit on main, origin/main one commit behind, one changed and one untracked file
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "po-digest-git-"));
const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "a.txt"), "1");
git("add", "."); git("commit", "-qm", "first");
git("update-ref", "refs/remotes/origin/main", "HEAD");
fs.writeFileSync(path.join(repo, "a.txt"), "2");
git("commit", "-qam", "second commit");
fs.writeFileSync(path.join(repo, "a.txt"), "3");
fs.writeFileSync(path.join(repo, "b.txt"), "new");
const g = gitFacts(repo);
assert.equal(g.changed, 1);
assert.equal(g.untracked, 1);
assert.equal(g.commit.subject, "second commit");
assert.equal(g.behind, 0);
assert.equal(g.ahead, 1);

const now = Date.now();
const tasks = [
  { id: 1, title: "Old", status: "done", updated: now - 5000 },
  { id: 2, title: "Newest", status: "done", updated: now - 1000 },
  { id: 3, title: "Working", status: "doing", updated: now },
  { id: 4, title: "Waiting", status: "todo", updated: now },
  { id: 5, title: "Stuck", status: "blocked", updated: now },
];
const tr = trOf(locale("tr"));
const before = buildDigest({ now, tasks, git: g, started: g.commit.ts - 60e3 }, tr);
const after = buildDigest({ now, tasks, git: g, started: g.commit.ts + 60e3 }, tr);
console.log(after);
assert.match(after, /1 yapılıyor, 0 incelemede, 1 takılı, 1 bekliyor/);
assert.match(after, /#3 Working \(yapılıyor\); #5 Stuck \(takılı\)/);
assert.match(after, /Son biten: #2 Newest .*; #1 Old/);
assert.match(after, /1 değişmiş, 1 izlenmeyen/);
assert.match(after, /0 gerisinde, 1 önünde/);
assert.match(after, /yani onu çalıştırıyor/);
assert.match(before, /henüz onu çalıştırmıyor/);
assert.ok(after.split("\n").length <= 12);

fs.rmSync(empty, { recursive: true, force: true });
fs.rmSync(repo, { recursive: true, force: true });
console.log("digest ok");
