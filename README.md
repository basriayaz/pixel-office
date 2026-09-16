# Pixel Office

A pixel-art virtual office for your Claude agents. Hire AI employees with a game-style character creator, give each one a job, watch them walk to their desks and work, and teach them things they never forget.

*Türkçe: [README.tr.md](README.tr.md)*

![Pixel Office](docs/office.jpg)

<details><summary>Hiring: game-style character creator, ready-made positions, model / effort / permission cards</summary>

![Hire](docs/hire.jpg)

</details>

Each employee is a persistent [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) session with its own:

- **job description** (system prompt) — who they are and what they own,
- **persistent memory** (`memory.md`) — what you teach them is written there and loaded every session; they also learn on their own and refresh their knowledge periodically,
- **skills** (`skills/<name>/SKILL.md`) — Claude Code skills loaded only for that employee,
- **model, effort and permission mode** — Haiku for routine work, Opus/Fable for the hard stuff,
- **look** — gender, body type, skin, hair, hat, glasses, outfit, shoes.

The office is a 2D pixel world with rooms (kitchen, open office, meeting room, lounge, archive). Idle employees wander, grab coffee, sit on the sofa and chat; when you give someone a task they walk back to their desk and start typing. Status is visible at a glance: working, waiting for your permission, done, unread reply.

Employees work **inside your project folder**: they read and edit files, run commands (with your permission), read your `CLAUDE.md`, and are also exposed as Claude Code subagents (`.claude/agents/`) so a terminal `claude` in the same project can delegate to them.

## Requirements

- Node.js 20+
- A Claude subscription logged into Claude Code (`claude` CLI) **or** an `ANTHROPIC_API_KEY` in your environment. The Agent SDK bundles the Claude Code runtime, so nothing else is needed.

## Install

Pixel Office is distributed from GitHub (not on npm yet).

```bash
git clone https://github.com/basriayaz/pixel-office.git
cd pixel-office
npm install          # also builds dist/
npm link             # makes the `pixel-office` command available globally
```

Or run it without installing anything globally:

```bash
npx github:basriayaz/pixel-office init
npx github:basriayaz/pixel-office
```

## Use it in your project

```bash
cd ~/my-project
pixel-office init            # creates .pixel-office/ (config, employees/_template) and git-ignores the data dir
pixel-office                 # starts the office on http://localhost:4747 and opens the browser
pixel-office stop            # stops it again (or use the ⏻ button in the top bar, or Ctrl+C in the terminal)
```

Then click **+ Hire** in the top bar: design the character, pick a ready-made position or write your own job description, choose model / effort / permissions, and hire. The employee's folder appears under `.pixel-office/employees/<id>/` immediately — no restart needed.

```
.pixel-office/
  config.json
  employees/
    _template/
    alex/
      agent.md        # identity + job description (frontmatter: name, role, color, model, effort, permissionMode, look, …)
      memory.md       # persistent memory — the employee writes here, you can edit it too
      skills/
        weekly-report/SKILL.md
  data/               # sessions and chat history (git-ignored)
```

Commit `.pixel-office/employees/` to share employees (and what they've learned) with your team. If you'd rather keep memories private, run `pixel-office init --no-memory-git` or add `.pixel-office/employees/*/memory.md` to `.gitignore` yourself.

### Turkish UI

```bash
pixel-office init --locale tr
```
or set `"locale": "tr"` in `.pixel-office/config.json`. Contributions of other locales are welcome — copy `locales/en.json`.

### Configuration (`.pixel-office/config.json`)

| key | default | meaning |
|---|---|---|
| `locale` | `"en"` | UI + prompt language (`en`, `tr`) |
| `port` | `4747` | HTTP port (env `PORT` overrides) |
| `host` | `"127.0.0.1"` | bind address — employees can run shell commands on your machine, so keep this on localhost |
| `employeesDir` | `".pixel-office/employees"` | where employee folders live |
| `dataDir` | `".pixel-office/data"` | sessions, chat history, refresh timestamps |
| `memoryFile` | `"memory.md"` | memory file name inside each employee folder |
| `cwd` | `"."` | working directory employees operate in (per-employee `cwd:` in `agent.md` overrides) |
| `syncClaudeAgents` | `true` | mirror employees into `<cwd>/.claude/agents/` as Claude Code subagents |
| `refreshHours` | `24` | how often idle employees revisit their memory and project docs |

Paths are relative to the project folder; `~` is expanded.

### Multiple offices

One server can host several offices (e.g. one per company or per team), switchable from tabs in the top bar. Each office has its own employee folder, default working directory and chat history:

```json
{
  "locale": "en",
  "dataDir": ".pixel-office/data",
  "offices": [
    { "id": "core",  "name": "Core",        "employeesDir": ".pixel-office/employees/core",  "cwd": "." },
    { "id": "shop",  "name": "Web Shop",    "employeesDir": ".pixel-office/employees/shop",  "cwd": "~/Projects/shop" },
    { "id": "app",   "name": "Mobile App",  "employeesDir": ".pixel-office/employees/app",   "cwd": "~/Projects/app",
      "employees": [".pixel-office/employees/core/alex"] }
  ]
}
```

Each office also has a **theme** (`"theme": "default" | "football" | "fashion" | "gothic" | "music"`, picked visually from rendered previews) — same floor plan, different walls, floors, furniture and room names (e.g. a football club with a scoreboard, tactics room and stands; a fashion atelier with a cutting table, mannequins, clothes racks and a fitting room; a gothic manor with stained glass, torches, a cauldron, a suit of armour and a crypt; a music studio for a YouTube channel with a play-button plaque, ON AIR sign, mixing console, drum kit, guitars, camera rig and a vinyl-record rug). Offices are managed from the ⚙ button next to the tabs: add (name, working directory, theme), rename, change theme or folder, delete (only when empty); changes are written to `config.json` and applied live.

`employees` lists extra employee folders to show in that office too — the same person (same memory and skills) working in two offices, each with its own chat and session. Chat data is stored per office under `dataDir/<office id>/`. Employee pages are office-scoped: `/?office=shop`, `hire.html?office=shop`, `/api/offices/shop/employees`.

## How the pieces fit

- **Chat** — click an employee (or the roster chip). Markdown replies, collapsed tool activity, permission cards (Allow / Always allow / Deny) and the questions employees ask you (with options).
- **Profile** (☰ in the chat header) — tenure, stats, appearance editor, job description, memory editor, skills (add/edit/delete), history, model/effort/permission settings, **Refresh knowledge**, and **Fire** (the folder is moved to `employees/_archive/`).
- **Self-learning** — every employee is instructed to add durable lessons to their memory after each task, and, when idle and `refreshHours` has passed since their last refresh, to re-read their memory and relevant project docs and tidy them up. You can trigger it any time from the profile.
- **Colleagues** — employees in the same office can talk to each other. Each one has `list_colleagues` and `message_colleague` tools: a support agent can hand an order cancellation to whoever owns orders, optionally wait for their answer and report back to you. The message shows up in the colleague's chat (with the sender's name) and as an activity line in the sender's chat.
- **Terminal** — `cd` into the project and run `claude`; the employees appear as subagents (`.claude/agents/<id>.md`), sharing the same memory files.
- **Closing the office** — ⏻ in the top bar (asks for confirmation), `pixel-office stop` in the project folder, or Ctrl+C in the terminal that started it. Running tasks are interrupted; chats, memories and skills stay on disk.

## Development

```bash
npm run dev          # tsx, no build step
npm run typecheck
```

`web/sprites.html` renders every character frame at 4× — handy when tweaking the sprite code in `web/office.js`.

## Security notes

Employees are Claude Code sessions with file and shell access to the configured working directory (and, with permission, anything else on the machine). The server binds to `127.0.0.1` for that reason; don't expose it to a network without adding authentication. `bypassPermissions` mode runs commands without asking — use it only for narrowly scoped, trusted employees.

## License

MIT
