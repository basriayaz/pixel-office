import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Employee } from "./employee.js";
import { TASK_STATUSES, type Board, type Task } from "./board.js";
import { slug } from "./agents.js";
import fs from "node:fs";
import { t } from "./runtime.js";

export interface Colleagues {
  list(): Employee[];
  board(): Board;
  // Hands a task to its owner: "waiting" = prerequisites still open (it starts by itself once they are done), "queued" = the owner is busy.
  launch(task: Task, from: Employee): "started" | "queued" | "waiting";
  // Why a discovery task / a move without the boss is not allowed right now (round limit, budget), or undefined when it is.
  discoveryBlock(): string | undefined;
  autoMoveBlock(): string | undefined;
  countDiscovery(): void;
}

export const OFFICE_TOOLS = ["remember", "propose_idea", "list_ideas", "promote_idea", "review_idea", "list_colleagues", "message_colleague", "raise_hand", "share_note", "read_notes", "edit_note", "delete_note", "list_tasks", "update_task", "assign_task", "start_task", "colleague_activity"].map((n) => `mcp__office__${n}`);

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
  const started = (k: Task, target: Employee) => {
    const r = colleagues.launch(k, self);
    return t(r === "started" ? "server.board.started" : r === "queued" ? "server.board.queued" : "server.board.waitingDeps", { id: k.id, name: target.cfg.name, deps: board().waitingOn(k).map((d) => "#" + d).join(", ") });
  };
  const taskLine = (k: Task) => `#${k.id} [${k.status}] ${k.title} — ${nameOf(k.owner)}${k.after?.length ? ` (${t("server.board.afterTag")} ${k.after.map((d) => "#" + d).join(", ")})` : ""}${k.notes.length ? ` (${t("server.board.lastNote")}: ${k.notes[k.notes.length - 1].text.slice(0, 160)})` : ""}`;
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
      // Memory without a path: wherever the employee happens to be working, the line lands in their own memory file.
      tool("remember", t("server.memoryTool.desc"), {
        fact: z.string().describe(t("server.memoryTool.factDesc")),
        section: z.string().optional().describe(t("server.memoryTool.sectionDesc")),
      }, async ({ fact, section }) => {
        const file = self.cfg.memoryFile;
        if (!file) return text(t("server.noMemory"), true);
        const line = "- " + fact.trim().replace(/\s*\n\s*/g, " ").slice(0, 500);
        let cur = "";
        try { cur = fs.readFileSync(file, "utf8"); } catch {}
        if (cur.includes(line.slice(2))) return text(t("server.memoryTool.known"));
        const head = section?.trim().replace(/^#+\s*/, "").slice(0, 60);
        const at = head ? cur.split("\n").findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === head.toLowerCase()) : -1;
        let next: string;
        if (head && at >= 0) {
          const lines = cur.split("\n");
          let end = lines.findIndex((l, i) => i > at && /^#{1,6}\s/.test(l));
          if (end < 0) end = lines.length;
          while (end > at + 1 && !lines[end - 1].trim()) end--;
          lines.splice(end, 0, line);
          next = lines.join("\n");
        } else next = cur.replace(/\s*$/, "") + (head ? `\n\n## ${head}\n` : "\n") + line + "\n";
        fs.writeFileSync(file, next);
        return text(t("server.memoryTool.saved", { file, chars: next.length }));
      }),
      // ---- ideas: suggestions that wait for the boss ----
      tool("propose_idea", t("server.ideas.proposeDesc"), {
        title: z.string().describe(t("server.ideas.titleDesc")),
        why: z.string().describe(t("server.ideas.whyDesc")),
        effort: z.enum(["S", "M", "L"]).optional().describe(t("server.ideas.effortDesc")),
        owner: z.string().optional().describe(t("server.ideas.ownerDesc")),
        tags: z.array(z.string()).optional(),
      }, async ({ title, why, effort, owner, tags }) => {
        const twin = board().similarIdea(title);
        if (twin) return text(t("server.ideas.similar", { id: twin.id, name: twin.byName, title: twin.title, status: twin.status }), true);
        const who = owner ? find(owner) ?? (slug(owner) === self.cfg.id || slug(owner) === slug(self.cfg.name) ? self : undefined) : undefined;
        const idea = board().addIdea(self.cfg.id, self.cfg.name, { title, text: why, effort, owner: who?.cfg.id, tags });
        return text(t("server.ideas.saved", { id: idea.id }));
      }),
      tool("list_ideas", t("server.ideas.listDesc"), { status: z.enum(["new", "later", "rejected", "moved"]).optional(), id: z.number().optional() }, async ({ status, id }) => {
        if (id) { const x = board().ideas.find((i) => i.id === id); return x ? text(`${t("server.board.notesAreData")}\n\n💡 #${x.id} [${x.status}] ${x.title}\n${x.byName}${x.effort ? " · " + x.effort : ""}${x.owner ? " · → " + nameOf(x.owner) : ""}${x.comment ? "\n" + t("server.meeting.boss") + ": " + x.comment : ""}\n\n${x.text}`) : text(t("server.ideas.none"), true); }
        const list = board().ideas.filter((x) => (status ? x.status === status : x.status === "new" || x.status === "later")).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
        return text(list.length ? t("server.board.notesAreData") + "\n\n" + list.map((x) => `💡 #${x.id} [${x.status}] ${x.title} — ${x.byName}${x.effort ? " · " + x.effort : ""}${x.owner ? " · → " + nameOf(x.owner) : ""}${x.comment ? ` (${t("server.meeting.boss")}: ${x.comment.slice(0, 120)})` : ""} — ${x.text.replace(/\s+/g, " ").slice(0, 140)}`).join("\n") : t("server.ideas.none"));
      }),
      // The manager sorts the box so the boss reads three cards, not thirty.
      tool("review_idea", t("server.ideas.reviewDesc"), {
        id: z.number(),
        rank: z.number().optional().describe(t("server.ideas.rankDesc")),
        advice: z.string().optional().describe(t("server.ideas.adviceDesc")),
        effort: z.enum(["S", "M", "L"]).optional(),
        owner: z.string().optional().describe(t("server.ideas.ownerDesc")),
        duplicate_of: z.number().optional().describe(t("server.ideas.duplicateDesc")),
      }, async ({ id, rank, advice, effort, owner, duplicate_of }) => {
        if (!self.cfg.manager) return notManager();
        const x = board().ideas.find((i) => i.id === id);
        if (!x || x.status === "moved") return text(t("server.ideas.cannotMove", { id }), true);
        if (duplicate_of) {
          if (!board().ideas.some((i) => i.id === duplicate_of && i.id !== id)) return text(t("server.ideas.none"), true);
          board().updateIdea(id, { status: "rejected", advice: t("server.ideas.duplicateNote", { id: duplicate_of }), rank: null });
          return text(t("server.ideas.merged", { id, into: duplicate_of }));
        }
        const who = owner ? find(owner) ?? (slug(owner) === self.cfg.id ? self : undefined) : undefined;
        board().updateIdea(id, { rank: rank === undefined ? undefined : rank, advice, effort, owner: who?.cfg.id });
        return text(t("server.ideas.reviewed", { id }));
      }),
      tool("promote_idea", t("server.ideas.promoteDesc"), {
        id: z.number(),
        to: z.string().describe(t("server.office.toDesc")),
        detail: z.string().optional().describe(t("server.board.taskDetailDesc")),
        start_now: z.boolean().optional().describe(t("server.board.startNowDesc")),
        needs_review: z.boolean().optional().describe(t("server.board.needsReviewDesc")),
        after: z.array(z.number()).optional().describe(t("server.board.afterDesc")),
      }, async ({ id, to, detail, start_now, needs_review, after }) => {
        if (!self.cfg.manager) return notManager();
        const target = find(to) ?? (slug(to) === self.cfg.id || slug(to) === slug(self.cfg.name) ? self : undefined);
        if (!target) return text(t("server.office.notFound", { name: to, list: others().map((e) => e.cfg.name).join(", ") }), true);
        const no = colleagues.autoMoveBlock();
        if (no) return text(no, true);
        const k = board().promoteIdea(id, target.cfg.id, self.cfg.id, { detail, review: !!needs_review, after });
        if (!k) return text(t("server.ideas.cannotMove", { id }), true);
        self.note(t("server.ideas.movedNote", { id, task: k.id, name: target.cfg.name, title: k.title }));
        if (!start_now || target === self) return text(t("server.ideas.moved", { id, task: k.id, name: target.cfg.name }));
        return text(t("server.ideas.moved", { id, task: k.id, name: target.cfg.name }) + " " + started(k, target));
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
        // the moment of closing is when what was noticed on the way is still fresh: ask for it here, at no extra turn
        const closing = status === "done" && k.owner === self.cfg.id && k.kind !== "discovery" ? "\n" + t("server.ideas.closingNudge") : "";
        return text((gated ? t("server.board.sentForReview", { id }) : t("server.board.updated", { id, status: next ?? k.status })) + closing);
      }),
      tool("assign_task", t("server.board.assignDesc"), {
        to: z.string().describe(t("server.office.toDesc")),
        title: z.string().describe(t("server.board.taskTitleDesc")),
        detail: z.string().describe(t("server.board.taskDetailDesc")),
        start_now: z.boolean().optional().describe(t("server.board.startNowDesc")),
        needs_review: z.boolean().optional().describe(t("server.board.needsReviewDesc")),
        after: z.array(z.number()).optional().describe(t("server.board.afterDesc")),
        discovery: z.boolean().optional().describe(t("server.cycle.discoveryDesc")),
      }, async ({ to, title, detail, start_now, needs_review, after, discovery }) => {
        if (!self.cfg.manager) return notManager();
        if (discovery) { const no = colleagues.discoveryBlock(); if (no) return text(no, true); }
        const target = find(to) ?? (slug(to) === self.cfg.id || slug(to) === slug(self.cfg.name) ? self : undefined);
        if (!target) return text(t("server.office.notFound", { name: to, list: others().map((e) => e.cfg.name).join(", ") }), true);
        const k = board().addTask(target.cfg.id, title, detail, self.cfg.id, !!needs_review && !discovery, after ?? [], discovery ? "discovery" : undefined);
        if (discovery) colleagues.countDiscovery();
        self.note(t("server.board.assignedNote", { id: k.id, name: target.cfg.name, title: k.title }));
        if (!start_now || target === self) return text(t("server.board.assigned", { id: k.id, name: target.cfg.name }));
        return text(started(k, target));
      }),
      // Nobody starts a task on their own: the owner gets it only when the manager (or the boss) says go.
      tool("start_task", t("server.board.startDesc"), { ids: z.array(z.number()).describe(t("server.board.startIdsDesc")) }, async ({ ids }) => {
        if (!self.cfg.manager) return notManager();
        const out: string[] = [];
        for (const id of ids) {
          const k = board().tasks.find((x) => x.id === id);
          const target = k && colleagues.list().find((e) => e.cfg.id === k.owner);
          if (!k) { out.push(t("server.board.noSuchTask", { id })); continue; }
          if (!target || target === self || k.status === "done") { out.push(t("server.board.noOwner", { id })); continue; }
          self.note(t("server.board.startedNote", { id, name: target.cfg.name, title: k.title }));
          out.push(started(k, target));
        }
        return text(out.join("\n"));
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
