import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Employee } from "./employee.js";
import { slug } from "./agents.js";
import { t } from "./runtime.js";

export interface Colleagues {
  list(): Employee[];
}

export const OFFICE_TOOLS = ["mcp__office__list_colleagues", "mcp__office__message_colleague"];

const text = (s: string, isError = false) => ({ content: [{ type: "text" as const, text: s }], ...(isError ? { isError: true } : {}) });

// In-process MCP server giving one employee a view of, and a line to, the colleagues in the same office.
export function officeServer(self: Employee, colleagues: Colleagues) {
  const others = () => colleagues.list().filter((e) => e !== self);
  const find = (to: string) => {
    const key = slug(to);
    return others().find((e) => e.cfg.id === key || slug(e.cfg.name) === key || e.cfg.name.toLowerCase() === to.trim().toLowerCase());
  };
  return createSdkMcpServer({
    name: "office",
    version: "1.0.0",
    instructions: t("server.office.instructions"),
    tools: [
      tool("list_colleagues", t("server.office.listDesc"), {}, async () => {
        const rows = others().map((e) => `- ${e.cfg.name} (${e.cfg.role}) — ${e.status}`);
        return text(rows.length ? rows.join("\n") : t("server.office.none"));
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
