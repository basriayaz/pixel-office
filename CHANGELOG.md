# Changelog

## Unreleased

- Meetings: **Meeting** in the top bar gathers the chosen employees in the meeting room and opens a group panel. What you say goes to everybody; each answers in a few sentences or passes, hears what the others said, and can raise a hand (`raise_hand` tool) to be given the floor. `@name` addresses one person. Ending writes a summary with follow-up tasks (one click sends a task to its owner), posts it to every participant's chat and optionally appends it to their memory. Transcripts are kept under `data/meetings/` and listed under "Past meetings".
- Chat: paste images with Ctrl+V or drop image files; they are sent with the message, shown in the history and stored under `data/attachments/`.
- Sickness: now and then an idle employee falls ill for 3–5 minutes — red cross over the head, rests on the sofa, messages wait until recovery; 💊 in the chat header sends them back early. `sickness: false` in `config.json` (or `PIXEL_OFFICE_SICKNESS=0`) turns it off.
- Nine more ready-made positions: Manager / Team Lead, Marketing Manager, Human Resources, Project Manager, Product Manager, Data Analyst, UI/UX Designer, Legal & Compliance, Operations.
- Character creator: crop top.
- Character creator: eye color; beard styles (stubble, mustache, goatee, circle beard, full, long) and beard color; nine new hair styles (buzz cut, side part, spiky, mohawk, afro, bald, balding, bob, braid); six new hats (cowboy, fedora, bucket, beret, bandana, hood); tank top, polo, shirt, sweater and suit (with tie color) tops; cargo pants, joggers, long shorts and long skirt; high-tops, loafers and sandals; shoe color; redrawn heels. Older `beard: true/false` looks still load.

## 0.1.0 — 2026-09-16

First public release.

- Pixel-art office with rooms, pathfinding, idle behaviour, six themes (classic, football club, fashion atelier, gothic manor, music studio, travel agency).
- Employees as Claude Agent SDK sessions: streaming chat, permission cards, questions, interrupt, session resume.
- Persistent memory per employee, self-learning and periodic refresh, per-employee skills.
- Game-style hiring (character creator, ready-made positions, model / effort / permission), profile page, firing.
- Multiple offices per server with per-office working folders; native folder picker.
- Colleague messaging between employees.
- Desktop notifications, first-run sample employees and welcome card, shutdown from UI/CLI.
- English and Turkish; live language switching from the top bar, OS language detected on first run.
