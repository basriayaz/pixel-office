import type { OfficeSettings } from "./config.js";
import type { Translator } from "./i18n.js";

// Process-wide settings + translator, initialized once by index.ts before employees are created.
let settings: OfficeSettings | null = null;
let translator: Translator | null = null;

export function initRuntime(s: OfficeSettings, tr: Translator) {
  settings = s;
  translator = tr;
}

export function getSettings(): OfficeSettings {
  if (!settings) throw new Error("runtime not initialized");
  return settings;
}

export function t(key: string, vars: Record<string, string | number> = {}): string {
  if (!translator) throw new Error("runtime not initialized");
  return translator.t(key, vars);
}

export function tget(key: string): unknown {
  return translator?.get(key);
}
