# Contributing

Thanks for helping make the office better. Small, focused pull requests are easiest to review.

## Setup

```bash
git clone https://github.com/basriayaz/pixel-office.git
cd pixel-office
npm install
npm run dev            # runs the server from src/ with tsx (no build step)
```

The web UI is plain HTML/CSS/JS under `web/` and is served as-is, so a browser refresh shows your changes. Server changes need a restart of `npm run dev`.

Use a scratch home so you don't touch your real office: `PIXEL_OFFICE_HOME=/tmp/po-dev PORT=4848 npm run dev`.

## Layout

- `src/server/` — Express + WebSocket server (TypeScript). `employee.ts` wraps one Claude Agent SDK session; `agents.ts` reads/writes employee folders; `config.ts` resolves where files live; `office-tools.ts` gives employees the colleague-messaging tools.
- `web/office.js` — the pixel world: rooms, pathfinding, furniture, themes, characters. `web/sprites.html` renders every character frame at 4×.
- `web/app.js` — office page (chat, roster, offices modal); `hire.js`, `employee.js`, `chareditor.js`, `shared.js`.
- `locales/*.json` — every user-facing string (server + UI). `templates/employee/<locale>/` — the employee template copied on init.

## Adding a language

1. Copy `locales/en.json` to `locales/<code>.json` and translate the values (keep the keys and the `{placeholders}`).
2. Copy `templates/employee/en/` to `templates/employee/<code>/` and translate.
3. Run `node scripts/check-locales.mjs` — it fails if a key is missing.
4. Set `"locale": "<code>"` in your config and click around.

## Adding a theme

Themes live at the end of `web/office.js`: a palette (`THEMES.<name>`), a set of props (`PROPS.<name>`, one function per furniture slot), a `drawWallDecor<Name>` and a `THEME_NAMES.push`. Add the name to `THEMES` in `src/server/config.ts` and room names + a label to both locale files. Keep wall decorations out of the two window areas (x 284–388 and 540–644).

## Before you open a PR

```bash
npm run typecheck
node scripts/check-locales.mjs
node scripts/smoke.mjs
```

Describe what you changed and how you tested it. Screenshots for anything visual are very welcome.
