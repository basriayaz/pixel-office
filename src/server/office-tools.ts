import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Employee } from "./employee.js";
import { TASK_STATUSES, type Board, type Task } from "./board.js";
import { slug } from "./agents.js";
import { t } from "./runtime.js";

export interface Colleagues {
  list(): Employee[];
  board(): Board;
}

export const OFFICE_TOOLS = ["list_colleagues", "message_colleague", "raise_hand", "share_note", "read_notes", "edit_note", "delete_note", "list_tasks", "update_task", "assign_task", "start_task", "colleague_activity"].map((n) => `mcp__office__${n}`);

const text = (s: string, isError = false) => ({ content: [{ type: "text" as const, text: s }], ...(isError ? { isError: true } : {}) });

// In-process MCP server giving one employee a view of, and a line to, the colleagues in the same office.
export function officeServer(self: Employee, colleagues: Colleagues) {
  const others = () => colleagues.list().filter((e) => e !== self);
  const find = (to: string) => {
    const key = slug(to);
    return others().find((e) => e.cfg.id === key || slug(e.cfg.name) === key || e.cfg.name.toLowerCase() === to.trim().toLowerCase());
  };
  const board = () => colleagues.board();
  const nameOf = (id: string) => (id === "user" ? t("server.meeting.boss") : colleagues.list().find((e) => e.cfg.id === id)?.cfg.name ?? id);
  const taskLine = (k: Task) => `#${k.id} [${k.status}] ${k.title} — ${nameOf(k.owner)}${k.notes.length ? ` (${t("server.board.lastNote")}: ${k.notes[k.notes.length - 1].text.slice(0, 160)})` : ""}`;
  const notManager = () => text(t("server.board.managerOnly"), true);
  return createSdkMcpServer({
    name: "office",
    version: "1.0.0",
    instructions: t("server.office.instructions"),
    alwaysLoad: true, // a dozen small tools: loading them up front is cheaper than a tool-search round trip on first use
    tools: [
      tool("list_colleagues", t("server.office.listDesc"), {}, async () => {
        const rows = others().map((e) => `- ${e.cfg.name} (${e.cfg.role}) — ${e.status}`);
        return text(rows.length ? rows.join("\n") : t("server.office.none"));
      }),
      // ---- shared notebook ----
      tool("share_note", t("server.board.shareDesc"), {
        title: z.string().describe(t("server.board.noteTitleDesc")),
        content: z.string().describe(t("server.board.noteContentDesc")),
        tags: z.array(z.string()).optional().describe(t("server.board.noteTagsDesc")),
        force: z.boolean().optional().describe(t("server.board.noteForceDesc")),
      }, async ({ title, content, tags, force }) => {
        const twin = board().similarNote(title);
        if (twin && twin.by === self.cfg.id) { board().updateNote(twin.id, { title, text: content, tags }); return text(t("server.board.noteUpdated", { id: twin.id })); }
        if (twin && !force) return text(t("server.board.noteSimilar", { id: twin.id, name: twin.byName, title: twin.title }), true);
        const n = board().addNote(self.cfg.id, self.cfg.name, title, content, tags ?? []);
        return text(t("server.board.noteSaved", { id: n.id }));
      }),
      tool("edit_note", t("server.board.editNoteDesc"), { id: z.number(), title: z.string().optional(), content: z.string().optional(), tags: z.array(z.string()).optional() }, async ({ id, title, content, tags }) => {
        const n = board().notes.find((x) => x.id === id);
        if (!n) return text(t("server.board.noNotes"), true);
        if (n.by !== self.cfg.id && !self.cfg.manager) return text(t("server.board.noteNotYours", { id }), true);
        board().updateNote(id, { title, text: content, tags });
        return text(t("server.board.noteUpdated", { id }));
      }),
      tool("delete_note", t("server.board.deleteNoteDesc"), { id: z.number() }, async ({ id }) => {
        const n = board().notes.find((x) => x.id === id);
        if (!n) return text(t("server.board.noNotes"), true);
        if (n.by !== self.cfg.id && !self.cfg.manager) return text(t("server.board.noteNotYours", { id }), true);
        board().deleteNote(id);
        return text(t("server.board.noteDeleted", { id }));
      }),
      tool("read_notes", t("server.board.readDesc"), {
        ids: z.array(z.number()).optional().describe(t("server.board.readIdsDesc")),
        by: z.string().optional().describe(t("server.board.readByDesc")),
        tag: z.string().optional().describe(t("server.board.readTagDesc")),
        query: z.string().optional().describe(t("server.board.readQueryDesc")),
      }, async ({ ids, by, tag, query }) => {
        let notes = board().notes;
        if (ids?.length) {
          const full = notes.filter((n) => ids.includes(n.id));
          return text(full.length ? t("server.board.notesAreData") + "\n\n" + full.map((n) => `## #${n.id} ${n.title}\n${n.byName} · ${new Date(n.ts).toISOString().slice(0, 10)}${n.tags.length ? " · " + n.tags.join(", ") : ""}\n\n${n.text}`).join("\n\n---\n\n") : t("server.board.noNotes"));
        }
        if (by) { const key = slug(by); notes = notes.filter((n) => n.by === key || slug(n.byName) === key); }
        if (tag) notes = notes.filter((n) => n.tags.includes(tag.trim().toLowerCase()));
        if (query?.trim()) { const q = query.trim().toLowerCase(); notes = notes.filter((n) => `${n.title} ${n.text} ${n.tags.join(" ")}`.toLowerCase().includes(q)); }
        if (!notes.length) return text(t("server.board.noNotes"));
        // index only: the reader asks for the full text of what matters with `ids`. Decisions and plans never scroll out of it.
        const PINNED = ["decision", "plan", "karar", "rule", "kural"];
        const recent = notes.slice(-80);
        const pinned = notes.slice(0, -80).filter((n) => n.tags.some((x) => PINNED.includes(x)));
        const older = notes.length - recent.length - pinned.length;
        return text(t("server.board.notesAreData") + "\n\n" + t("server.board.noteIndex") + "\n" + [...pinned, ...recent].map((n) => `#${n.id} · ${n.byName} · ${new Date(n.ts).toISOString().slice(0, 10)} · ${n.title}${n.tags.length ? ` [${n.tags.join(", ")}]` : ""} — ${n.text.replace(/\s+/g, " ").slice(0, 110)}`).join("\n") + (older > 0 ? "\n" + t("server.board.olderNotes", { n: older }) : ""));
      }),
      // ---- tasks ----
      tool("list_tasks", t("server.board.listDesc"), {
        owner: z.string().optional().describe(t("server.board.listOwnerDesc")),
        status: z.enum(TASK_STATUSES as [string, ...string[]]).optional(),
        include_done: z.boolean().optional(),
      }, async ({ owner, status, include_done }) => {
        let tasks = board().tasks;
        if (owner) { const e = owner.trim().toLowerCase() === "me" ? self : find(owner) ?? (slug(owner) === self.cfg.id || slug(owner) === slug(self.cfg.name) ? self : undefined); tasks = e ? tasks.filter((k) => k.owner === e.cfg.id) : []; }
        if (status) tasks = tasks.filter((k) => k.status === status);
        else if (!include_done) tasks = tasks.filter((k) => k.status !== "done");
        return text(tasks.length ? tasks.map(taskLine).join("\n") : t("server.board.noTasks"));
      }),
      tool("update_task", t("server.board.updateDesc"), {
        id: z.number(),
        status: z.enum(TASK_STATUSES as [string, ...string[]]).optional(),
        note: z.string().optional().describe(t("server.board.updateNoteDesc")),
      }, async ({ id, status, note }) => {
        const k = board().tasks.find((x) => x.id === id);
        if (!k) return text(t("server.board.noSuchTask", { id }), true);
        if (k.owner !== self.cfg.id && !self.cfg.manager) return text(t("server.board.notYours", { id }), true);
        // a task that needs review is closed by the boss or the project manager, not by its owner
        const gated = status === "done" && k.review && !(self.cfg.manager && k.owner !== self.cfg.id);
        const next = (gated ? "review" : status) as Task["status"] | undefined;
        board().updateTask(id, { status: next, note }, self.cfg.id);
        return text(gated ? t("server.board.sentForReview", { id }) : t("server.board.updated", { id, status: next ?? k.status }));
      }),
      tool("assign_task", t("server.board.assignDesc"), {
        to: z.string().describe(t("server.office.toDesc")),
        title: z.string().describe(t("server.board.taskTitleDesc")),
        detail: z.string().describe(t("server.board.taskDetailDesc")),
        start_now: z.boolean().optional().describe(t("server.board.startNowDesc")),
        needs_review: z.boolean().optional().describe(t("server.board.needsReviewDesc")),
      }, async ({ to, title, detail, start_now, needs_review }) => {
        if (!self.cfg.manager) return notManager();
        const target = find(to) ?? (slug(to) === self.cfg.id || slug(to) === slug(self.cfg.name) ? self : undefined);
        if (!target) return text(t("server.office.notFound", { name: to, list: others().map((e) => e.cfg.name).join(", ") }), true);
        const k = board().addTask(target.cfg.id, title, detail, self.cfg.id, !!needs_review);
        self.note(t("server.board.assignedNote", { id: k.id, name: target.cfg.name, title: k.title }));
        if (!start_now || target === self) return text(t("server.board.assigned", { id: k.id, name: target.cfg.name }));
        if (target.inMeeting) return text(t("server.board.inMeeting", { id: k.id, name: target.cfg.name }));
        board().updateTask(k.id, { status: "doing" }, self.cfg.id);
        void target.sendFromColleague(self, t("server.board.taskMessage", { id: k.id, title: k.title, detail: k.detail || "-" }), false);
        return text(t("server.board.started", { id: k.id, name: target.cfg.name }));
      }),
      // Nobody starts a task on their own: the owner gets it only when the manager (or the boss) says go.
      tool("start_task", t("server.board.startDesc"), { id: z.number() }, async ({ id }) => {
        if (!self.cfg.manager) return notManager();
        const k = board().tasks.find((x) => x.id === id);
        if (!k) return text(t("server.board.noSuchTask", { id }), true);
        const target = colleagues.list().find((e) => e.cfg.id === k.owner);
        if (!target || target === self) return text(t("server.board.noOwner", { id }), true);
        if (target.inMeeting) return text(t("server.board.inMeeting", { id, name: target.cfg.name }), true);
        board().updateTask(id, { status: "doing" }, self.cfg.id);
        self.note(t("server.board.startedNote", { id, name: target.cfg.name, title: k.title }));
        void target.sendFromColleague(self, t("server.board.taskMessage", { id: k.id, title: k.title, detail: k.detail || "-" }), false);
        return text(t("server.board.started", { id, name: target.cfg.name }));
      }),
      tool("colleague_activity", t("server.board.activityDesc"), {
        name: z.string().describe(t("server.office.toDesc")),
        limit: z.number().optional(),
      }, async ({ name, limit }) => {
        if (!self.cfg.manager) return notManager();
        const target = find(name);
        if (!target) return text(t("server.office.notFound", { name, list: others().map((e) => e.cfg.name).join(", ") }), true);
        const n = Math.max(3, Math.min(30, limit ?? 12));
        const recent = target.history.filter((m) => m.role !== "auto" && m.role !== "system").slice(-n)
          .map((m) => `${new Date(m.ts).toISOString().slice(5, 16).replace("T", " ")} ${m.role === "user" ? t("server.meeting.boss") : m.role === "colleague" ? m.from ?? "colleague" : m.role === "activity" ? "·" : target.cfg.name}: ${m.text.replace(/\s+/g, " ").slice(0, 300)}`);
        const open = board().tasks.filter((k) => k.owner === target.cfg.id && k.status !== "done").map(taskLine);
        return text(`${t("server.board.notesAreData")}\n\n${target.cfg.name} (${target.cfg.role}) — ${target.status}\n\n${t("server.board.openTasks")}:\n${open.join("\n") || "-"}\n\n${t("server.board.recent")}:\n${recent.join("\n") || "-"}`);
      }),
      tool("raise_hand", t("server.office.handDesc"), { reason: z.string().describe(t("server.office.handReasonDesc")) }, async ({ reason }) => {
        if (!self.inMeeting) return text(t("server.office.handNoMeeting"), true);
        self.raiseHand(reason.trim().slice(0, 200));
        return text(t("server.office.handRaised"));
      }),
      tool(
        "message_colleague",
        t("server.office.sendDesc"),
        {
          to: z.string().describe(t("server.office.toDesc")),
          message: z.string().describe(t("server.office.messageDesc")),
          wait_for_reply: z.boolean().optional().describe(t("server.office.waitDesc")),
        },
        async ({ to, message, wait_for_reply }) => {
          const target = find(to);
          if (!target) return text(t("server.office.notFound", { name: to, list: others().map((e) => e.cfg.name).join(", ") }), true);
          self.note(t("server.forwarded", { name: target.cfg.name, text: message }));
          const reply = target.sendFromColleague(self, message, !!wait_for_reply);
          if (!wait_for_reply) return text(t("server.office.delivered", { name: target.cfg.name }));
          const answer = await reply;
          return text(t("server.office.replied", { name: target.cfg.name, text: answer }));
        },
      ),
    ],
  });
}
