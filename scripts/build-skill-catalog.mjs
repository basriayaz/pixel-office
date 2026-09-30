// Builds catalog/skills.json: the skills the market offers, pinned to a commit of their source repository.
// Needs the GitHub CLI (`gh auth login`) for the tree listing. Run it to add skills or to move to newer commits (then read the diff:
// a skill's files change with its sha, and the market shows the boss a preview of what they would get).
//   node scripts/build-skill-catalog.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "catalog", "skills.json");
const CATEGORIES = ["code", "design", "video", "work", "data", "cloud", "security", "business", "research"];
// vendor -> repo, how it is shown, and the skills to offer (folder name -> category)
const REPOS = [
  { repo: "anthropics/skills", vendor: "Anthropic", icon: "anthropic", brand: "#d97757", skills: { "frontend-design": "design", "skill-creator": "work", "mcp-builder": "code", "webapp-testing": "code", "claude-api": "code" } },
  { repo: "obra/superpowers", vendor: "Superpowers", skills: { "systematic-debugging": "code", "test-driven-development": "code", "verification-before-completion": "code", "requesting-code-review": "code", "receiving-code-review": "code", "using-git-worktrees": "code", brainstorming: "work", "writing-plans": "work", "executing-plans": "work", "dispatching-parallel-agents": "work", "subagent-driven-development": "work" } },
  { repo: "heygen-com/hyperframes", vendor: "HeyGen", icon: "heygen.png", skills: { hyperframes: "video", "hyperframes-core": "video", "hyperframes-creative": "video", "hyperframes-animation": "video", "hyperframes-audio": "video", "hyperframes-cli": "video", "hyperframes-keyframes": "video", "product-launch-video": "video", "pr-to-video": "video", "faceless-explainer": "video", "talking-head-recut": "video", "embedded-captions": "video", "music-to-video": "video", slideshow: "video", "motion-graphics": "video", "general-video": "video", "media-use": "video" } },
  { repo: "vercel-labs/agent-skills", vendor: "Vercel", icon: "vercel", brand: "#e8e6df", skills: { "react-best-practices": "code", "composition-patterns": "code", "web-design-guidelines": "design", "deploy-to-vercel": "cloud" } },
  { repo: "supabase/agent-skills", vendor: "Supabase", icon: "supabase", brand: "#3ecf8e", skills: { supabase: "data", "supabase-postgres-best-practices": "data" } },
  { repo: "cloudflare/skills", vendor: "Cloudflare", icon: "cloudflare", brand: "#f6821f", skills: { cloudflare: "cloud", wrangler: "cloud", "workers-best-practices": "cloud", "durable-objects": "cloud" } },
  { repo: "stripe/ai", vendor: "Stripe", icon: "stripe", brand: "#7a73ff", skills: { "stripe-best-practices": "business", "stripe-docs": "business", "upgrade-stripe": "business" } },
  { repo: "getsentry/skills", vendor: "Sentry", icon: "sentry", brand: "#b58cf5", skills: { "code-review": "code", "find-bugs": "security", "security-review": "security", "gha-security-review": "security", "iterate-pr": "code", "skill-scanner": "security", "skill-writer": "work", "pr-writer": "code" } },
  { repo: "firecrawl/skills", vendor: "Firecrawl", icon: "firecrawl", brand: "#ff6a3d", skills: { firecrawl: "research", "firecrawl-deep-research": "research", "firecrawl-competitive-intel": "research", "firecrawl-market-research": "research", "firecrawl-seo-audit": "research", "firecrawl-lead-research": "research" } },
  { repo: "resend/resend-skills", vendor: "Resend", icon: "resend", brand: "#e8e6df", skills: { "email-best-practices": "business", "react-email": "design" } },
  { repo: "makenotion/skills", vendor: "Notion", icon: "notion", brand: "#e8e6df", skills: { "notion-cli": "work", "notion-apps": "work" } },
  { repo: "huggingface/skills", vendor: "Hugging Face", icon: "huggingface", brand: "#ffcc4d", skills: { "hf-cli": "data", "huggingface-datasets": "data", "huggingface-papers": "research", "huggingface-spaces": "code", "huggingface-llm-trainer": "data", "transformers-js": "code" } },
  { repo: "prisma/skills", vendor: "Prisma", icon: "prisma", brand: "#e8e6df", skills: { "prisma-client-api": "data", "prisma-database-setup": "data", "prisma-cli": "data" } },
  { repo: "neondatabase/agent-skills", vendor: "Neon", icon: "neon", brand: "#00e599", skills: { "neon-postgres": "data", "neon-postgres-branches": "data" } },
  { repo: "openai/skills", vendor: "OpenAI", icon: "openai", brand: "#e8e6df", skills: { playwright: "code", "gh-fix-ci": "code", "security-best-practices": "security", "security-threat-model": "security", transcribe: "video", pdf: "work", "jupyter-notebook": "data" } },
];
const gh = (p, jq) => { const o = execFileSync("gh", ["api", p, ...(jq ? ["--jq", jq] : [])], { encoding: "utf8", maxBuffer: 64e6 }); return jq ? o.trim() : JSON.parse(o); };
const SCRIPT_EXT = /\.(py|sh|bash|js|mjs|cjs|ts|rb|ps1)$/i;

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const meta = {};
  if (m) {
    let key = null;
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (kv) { key = kv[1]; meta[key] = kv[2].replace(/^(>-?|\|-?)$/, "").replace(/^["']|["']$/g, ""); }
      else if (key && /^\s+\S/.test(line)) meta[key] = `${meta[key]} ${line.trim()}`.trim();
    }
  }
  return { meta, body: m ? text.slice(m[0].length) : text };
}

const skills = [];
const missing = [];
for (const r of REPOS) {
  const [owner, name] = r.repo.split("/");
  const info = gh(`repos/${r.repo}`);
  const sha = gh(`repos/${r.repo}/commits/${info.default_branch}`, ".sha");
  const tree = gh(`repos/${r.repo}/git/trees/${sha}?recursive=1`).tree;
  const licence = info.license?.spdx_id && info.license.spdx_id !== "NOASSERTION" ? info.license.spdx_id : "";
  for (const [folder, category] of Object.entries(r.skills)) {
    const cands = tree.filter((t) => t.type === "blob" && t.path.endsWith(`/${folder}/SKILL.md`) && !/deprecated|\/evals?\/|\.claude\/|\.agents\/|node_modules/.test(t.path) || t.path === `${folder}/SKILL.md`);
    cands.sort((a, b) => (a.path.startsWith("skills/") ? 0 : 1) - (b.path.startsWith("skills/") ? 0 : 1) || a.path.length - b.path.length);
    if (!cands.length) { missing.push(`${r.repo}:${folder}`); continue; }
    const dir = cands[0].path.replace(/\/?SKILL\.md$/, "");
    const files = tree.filter((t) => t.path.startsWith(dir ? `${dir}/` : "") && (dir || !t.path.startsWith(".")));
    if (files.some((t) => t.mode === "120000" || t.type === "commit")) { missing.push(`${r.repo}:${folder} (symlink)`); continue; }
    const blobs = files.filter((t) => t.type === "blob");
    const rel = (p) => (dir ? p.slice(dir.length + 1) : p);
    const raw = await (await fetch(`https://raw.githubusercontent.com/${r.repo}/${sha}/${dir ? dir + "/" : ""}SKILL.md`)).text();
    const { meta, body } = frontmatter(raw);
    const description = (meta.description || "").replace(/\s+/g, " ").trim();
    if (!description) { missing.push(`${r.repo}:${folder} (no description)`); continue; }
    const id = `${name === "skills" || name === "agent-skills" || name === "ai" ? owner : name}_${folder}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 70);
    skills.push({
      id, name: folder, vendor: r.vendor, repo: r.repo, sha, path: dir, category,
      description: description.slice(0, 1024), license: !meta.license || /LICENSE/i.test(meta.license) ? licence || (r.repo === "anthropics/skills" || folder === "pdf" ? "Apache-2.0" : "see the repository") : meta.license,
      ...(r.icon ? { icon: r.icon } : {}), ...(r.brand ? { brand: r.brand } : {}),
      scripts: blobs.some((t) => /(^|\/)scripts\//.test(rel(t.path)) || SCRIPT_EXT.test(t.path)),
      bytes: blobs.reduce((n, t) => n + (t.size || 0), 0), bodyChars: body.length,
      files: blobs.map((t) => [rel(t.path), t.size || 0]),
    });
  }
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ categories: CATEGORIES, skills }, null, 1) + "\n");
console.log(`${skills.length} skills written to catalog/skills.json`);
if (missing.length) console.log("skipped:", missing.join(", "));
