import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "./fsutil.js";

// Price tables for the engines whose turns report tokens but no cost (Codex, Gemini): USD per 1M tokens. Codex on a
// ChatGPT plan bills nothing, so its figure is an API-equivalent estimate; Gemini is billed on the user's API key.
// The built-in rows below go stale when a provider changes prices or ships a model; `<dataDir>/prices.json` adds rows
// in front of them (first match wins), edited by hand or through PUT /api/prices, and is re-read when it changes:
//   { "codex": [{ "match": "gpt-6", "input": 2, "cached": 0.2, "output": 16 }], "gemini": [...] }
// `match` is a case-insensitive regular expression tested against the model id.

export type PricedEngine = "codex" | "gemini";
export const PRICED_ENGINES: PricedEngine[] = ["codex", "gemini"];
export interface PriceRow { match: string; input: number; cached: number; output: number }
export type PriceTable = Record<PricedEngine, PriceRow[]>;

export const DEFAULT_PRICES: PriceTable = {
  codex: [
    { match: "mini", input: 0.25, cached: 0.025, output: 2 },
    { match: "nano", input: 0.05, cached: 0.005, output: 0.4 },
    { match: "^gpt-5|codex", input: 1.25, cached: 0.125, output: 10 },
    { match: "", input: 1.25, cached: 0.125, output: 10 },
  ],
  gemini: [
    { match: "flash-lite", input: 0.1, cached: 0.025, output: 0.4 },
    { match: "flash", input: 0.3, cached: 0.075, output: 2.5 },
    { match: "gemini-3.*pro", input: 2, cached: 0.2, output: 12 },
    { match: "pro", input: 1.25, cached: 0.31, output: 10 },
    { match: "", input: 1.25, cached: 0.31, output: 10 },
  ],
};

const MAX_ROWS = 100, MAX_PRICE = 10000;
let file = "";
let cache: { mtime: number; table: PriceTable; compiled: Record<PricedEngine, Array<[RegExp, PriceRow]>> } | undefined;

export function initPrices(dataDir: string) { file = path.join(dataDir, "prices.json"); cache = undefined; }
export const pricesFile = () => file;

/** Checks a table from the file or a request: throws with a readable message on the first bad row. */
export function parsePrices(raw: unknown): PriceTable {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("prices must be an object like {\"codex\": [...], \"gemini\": [...]}");
  const out: PriceTable = { codex: [], gemini: [] };
  for (const eng of PRICED_ENGINES) {
    const rows = (raw as Record<string, unknown>)[eng];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw new Error(`${eng}: must be a list`);
    if (rows.length > MAX_ROWS) throw new Error(`${eng}: at most ${MAX_ROWS} rows`);
    rows.forEach((r, i) => {
      const at = `${eng}[${i}]`, row = (r ?? {}) as Record<string, unknown>;
      const match = row.match;
      if (typeof match !== "string" || !match.trim() || match.length > 200) throw new Error(`${at}.match: a non-empty pattern of up to 200 characters`);
      try { new RegExp(match, "i"); } catch { throw new Error(`${at}.match: not a valid regular expression`); }
      const num = (k: string, fallback?: number) => {
        const v = row[k] ?? fallback;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_PRICE) throw new Error(`${at}.${k}: a price between 0 and ${MAX_PRICE} (USD per 1M tokens)`);
        return v;
      };
      const input = num("input");
      out[eng].push({ match: match.trim(), input, cached: num("cached", input), output: num("output") });
    });
  }
  return out;
}

function load() {
  let mtime = -1;
  try { mtime = file ? fs.statSync(file).mtimeMs : -1; } catch { /* no file: built-in prices only */ }
  if (cache && cache.mtime === mtime) return cache;
  let table: PriceTable = { codex: [], gemini: [] };
  if (mtime >= 0) {
    try { table = parsePrices(JSON.parse(fs.readFileSync(file, "utf8"))); }
    catch (err) { console.warn(`[prices] ${file} ignored, built-in prices used: ${(err as Error).message}`); }
  }
  const compiled = {} as Record<PricedEngine, Array<[RegExp, PriceRow]>>;
  for (const eng of PRICED_ENGINES) compiled[eng] = [...table[eng], ...DEFAULT_PRICES[eng]].map((r) => [new RegExp(r.match, "i"), r]);
  cache = { mtime, table, compiled };
  return cache;
}

/** The user's rows (without the built-in ones). */
export const customPrices = (): PriceTable => load().table;

export function priceOf(engine: PricedEngine, model: string): PriceRow {
  return load().compiled[engine].find(([re]) => re.test(model))![1]; // the last built-in row matches everything
}

/** Estimated USD for a turn; `cached` is part of `input`, as the engines report it. */
export function costOf(engine: PricedEngine, model: string, t: { input: number; output: number; cached?: number }): number {
  const p = priceOf(engine, model);
  const cached = Math.min(Math.max(0, t.cached ?? 0), t.input);
  return ((t.input - cached) * p.input + cached * p.cached + t.output * p.output) / 1e6;
}

export function saveCustomPrices(table: PriceTable) {
  if (!file) throw new Error("prices are not initialised");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomicSync(file, JSON.stringify(table, null, 2) + "\n");
  cache = undefined;
}
