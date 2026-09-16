import fs from "node:fs";
import path from "node:path";
import { PKG_ROOT } from "./config.js";

export type Locale = Record<string, unknown>;

export function loadLocale(code: string): { code: string; data: Locale } {
  const dir = path.join(PKG_ROOT, "locales");
  const file = path.join(dir, `${code}.json`);
  const fallback = path.join(dir, "en.json");
  const base = JSON.parse(fs.readFileSync(fallback, "utf8")) as Locale;
  if (code === "en" || !fs.existsSync(file)) return { code: "en", data: base };
  return { code, data: deepMerge(base, JSON.parse(fs.readFileSync(file, "utf8")) as Locale) };
}

export function availableLocales(): Array<{ code: string; name: string }> {
  const dir = path.join(PKG_ROOT, "locales");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    const code = f.slice(0, -5);
    let name = code;
    try { name = String((JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Locale).name ?? code); } catch {}
    return { code, name };
  }).sort((a, b) => a.code.localeCompare(b.code));
}

// Best guess of the user's language from the OS ($LANG on Unix, the Intl default locale on Windows), if we ship it.
export function detectLocale(): string {
  const codes = new Set(availableLocales().map((l) => l.code));
  const candidates = [process.env.PIXEL_OFFICE_LOCALE, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG, Intl.DateTimeFormat().resolvedOptions().locale];
  for (const c of candidates) {
    const code = String(c ?? "").toLowerCase().split(/[._@-]/)[0];
    if (code && codes.has(code)) return code;
  }
  return "en";
}

function deepMerge(a: Locale, b: Locale): Locale {
  const out: Locale = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && !Array.isArray(out[k])) out[k] = deepMerge(out[k] as Locale, v as Locale);
    else out[k] = v;
  }
  return out;
}

export class Translator {
  constructor(private data: Locale) {}

  get(pathKey: string): unknown {
    return pathKey.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Locale)[k] : undefined), this.data);
  }

  // t("server.allowed", { title }) → "Allowed: …"
  t(key: string, vars: Record<string, string | number> = {}): string {
    const v = this.get(key);
    const s = typeof v === "string" ? v : key;
    return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
  }
}
