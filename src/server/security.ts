import os from "node:os";
import type { IncomingMessage } from "node:http";
import type { Request, Response, NextFunction } from "express";

// The office has no login: it trusts whoever can reach it, which should only ever be the boss's own browser and local
// programs (the `pixel-office stop` CLI, Codex's MCP calls, scripts). Two things keep web pages out:
//
// - Host check on every request and WebSocket upgrade. A DNS-rebinding page reaches 127.0.0.1 under its own name
//   (evil.example:4747), so a Host that is not one of our own names is refused before anything is served.
// - Origin check on WebSocket upgrades and on every call that changes something. Browsers always send Origin there, so a
//   foreign page (or `null` from a sandboxed frame / file://) is refused. Programs that are not browsers send no Origin
//   and are let through: the CLI's shutdown call and the MCP endpoint depend on that, and a local program could read the
//   data folder anyway. Sec-Fetch-Site additionally stops cross-site reads like <script src=".../i18n.js">, while plain
//   navigations (a link to the office) still work.

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
const WILDCARD = new Set(["0.0.0.0", "::", "[::]", ""]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const isLoopbackHost = (h: string) => LOOPBACK.includes(bracket(h.toLowerCase())) || /^127\./.test(h);
const bracket = (h: string) => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);

export interface Guard {
  hostOk(host: string | undefined): boolean;
  originOk(origin: string | undefined): boolean;
  /** Why a request must be refused, or undefined when it may pass. */
  refuse(req: IncomingMessage, opts: { changes: boolean }): string | undefined;
  middleware(req: Request, res: Response, next: NextFunction): void;
  /** For `new WebSocketServer({ verifyClient })`. */
  verifyClient(info: { origin: string; req: IncomingMessage }, cb: (ok: boolean, code?: number, message?: string) => void): void;
}

export function createGuard(opts: { port: number; host: string; extraHosts?: string[] }): Guard {
  const names = new Set(LOOPBACK);
  const bind = opts.host.trim().toLowerCase();
  if (WILDCARD.has(bind)) {
    // Listening on every interface (only with PIXEL_OFFICE_ALLOW_REMOTE=1): the machine's own names and addresses count as ours.
    const hn = os.hostname().toLowerCase();
    names.add(hn); names.add(hn.endsWith(".local") ? hn : `${hn}.local`);
    for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) names.add(bracket(a.address.toLowerCase()));
  } else names.add(bracket(bind));
  // PIXEL_OFFICE_ALLOWED_HOSTS: a bare name is allowed at the office's port; "name:port" allows that name at that port only
  // (an SSH or editor port-forward that reaches the office from another local port, e.g. "localhost:9000").
  const pairs = new Set<string>();
  for (const raw of opts.extraHosts ?? []) {
    const h = raw.trim().toLowerCase();
    if (!h) continue;
    const withPort = /^\[[^\]]*\]:\d+$/.test(h) || /^[^:\[\]]+:\d+$/.test(h);
    if (!withPort) { names.add(bracket(h)); continue; }
    try { const u = new URL(`http://${h}`); pairs.add(`${u.hostname.replace(/\.$/, "")}:${u.port || "80"}`); } catch {}
  }
  const port = String(opts.port);

  const hostPortOk = (hostname: string, p: string) => {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    return (names.has(h) && (p === port || (p === "" && port === "80"))) || pairs.has(`${h}:${p || "80"}`);
  };

  const hostOk = (host: string | undefined) => {
    if (!host) return false;
    try { const u = new URL(`http://${host}`); return u.username === "" && u.pathname === "/" && hostPortOk(u.hostname, u.port); }
    catch { return false; }
  };
  const originOk = (origin: string | undefined) => {
    if (origin === undefined) return true; // not a browser
    try { const u = new URL(origin); return (u.protocol === "http:" || u.protocol === "https:") && hostPortOk(u.hostname, u.port); }
    catch { return false; } // includes "null"
  };

  const refuse = (req: IncomingMessage, { changes }: { changes: boolean }) => {
    const h = req.headers;
    if (!hostOk(h.host)) return `host ${JSON.stringify(h.host ?? "")}`;
    const origin = typeof h.origin === "string" ? h.origin : undefined;
    if (changes && !originOk(origin)) return `origin ${JSON.stringify(origin)}`;
    const site = h["sec-fetch-site"], mode = h["sec-fetch-mode"];
    if ((site === "cross-site" || site === "same-site") && mode !== "navigate") return `sec-fetch-site ${site}`;
    return undefined;
  };

  // One log line per distinct reason, so a page that keeps knocking does not flood the terminal.
  const logged = new Set<string>();
  const log = (what: string, reason: string) => {
    const key = `${what} ${reason}`;
    if (logged.has(key) || logged.size > 200) return;
    logged.add(key);
    console.warn(`[security] refused ${what}: ${reason}`);
  };

  return {
    hostOk, originOk, refuse,
    middleware(req, res, next) {
      const why = refuse(req, { changes: !SAFE_METHODS.has(req.method) });
      if (!why) return next();
      log(`${req.method} ${req.path}`, why);
      res.status(403).json({ error: "Forbidden: this office only accepts requests from its own page." });
    },
    verifyClient(info, cb) {
      const why = refuse(info.req, { changes: true });
      if (!why) return cb(true);
      log("websocket", why);
      cb(false, 403, "Forbidden");
    },
  };
}
