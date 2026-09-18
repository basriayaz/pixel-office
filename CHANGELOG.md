# Changelog

## Unreleased

- Board (📋 in the top bar): an office **task list** and a **shared notebook**. Employees save important findings to the notebook (`share_note`, `read_notes`) and build on each other's notes. Only the boss and the project manager put tasks on the board; a listed task is a plan and nobody starts it until **Start** is pressed, the project manager starts it, or the owner is told to do their open tasks. Owners mark their tasks doing, done or blocked with a short note (`list_tasks`, `update_task`).
- Board safeguards: tasks can require **review** (the owner's "done" becomes "in review" until you or the project manager approve or send it back); tasks whose owner is waiting for your permission, hit a session error, stopped working or left the office are flagged on the board and counted on the button; a task is not started while its owner sits in a meeting; meeting follow-ups are **added to the board** instead of being sent straight to work; one project manager per office.
- Notebook safeguards: notes are handed to employees as information, never as instructions; a note with a near-identical title is updated (same author) or pointed out (other author) instead of duplicated; `edit_note` / `delete_note` for authors and the project manager; decisions and plans never scroll out of the index; text search.
- **Own working copy** per employee (profile → Settings): a private git worktree under `.pixel-office/worktrees/<id>` on branch `po/<id>`, so developers working at the same time cannot overwrite each other. Merging stays with you or the project manager.
- Office tools are loaded up front (`alwaysLoad`), removing a tool-search round trip on first use.
- Project manager: tick **Project manager** on an employee's profile (`manager: true` in `agent.md`). They read the whole notebook, look at what a colleague has been doing without interrupting them (`colleague_activity`), put tasks on the board (`assign_task`) and start them when you say so (`start_task`). Ask them where things stand, what is missing and what comes next.
- Seventeen more ready-made positions: Mobile, Frontend and Backend Developer, DevOps Engineer, QA Engineer, AI / ML Engineer, Data Engineer, Graphic Designer, Market & Competitor Analyst, Business Analyst, Business Development, Growth Manager, Strategy Consultant, PR & Communications, Community Manager, Copywriter, E-commerce Manager.
- New office theme **Dream studio** for dream-interpretation and visualisation teams: night-sky windows with a moon and drifting clouds, moon phases and floating z's on the wall, cloud floors, a starry carpet, a moon rug, an analyst's couch, glowing crystal balls, a grandfather clock with a swinging pendulum, an hourglass, a dreamcatcher, an apothecary cabinet, a pillow pile and an easel where a dream is being painted.
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
