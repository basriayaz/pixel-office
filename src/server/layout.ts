import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { PKG_ROOT } from "./config.js";
import { isObject, readJsonSafe, removeWithBackup, writeJsonAtomicSync } from "./fsutil.js";

// The furniture layout of an office (where the desks, the fridge, the sofa ... stand): one JSON file per office, written atomically.
// No file = the classic layout. The geometry rules (walls, doors, overlap, reachability of every desk and hangout spot, a desk for
// everybody) live in web/layout.js, the same file the browser runs; the server loads it here and checks every layout it is sent.
export interface LayoutItem { id: string; type: string; tx: number; ty: number; dir?: string; v?: number; water?: boolean; emp?: string; skin?: string }
export interface LayoutDoc { v: 1; items: LayoutItem[]; decor?: boolean } // decor: the wall decor and the rug are stored in items (otherwise the office's defaults apply)
interface Lib {
  MAX_EMP: number;
  sanitize(doc: unknown): { ok: boolean; items?: LayoutItem[]; decor?: boolean; error?: string };
  check(items: LayoutItem[], o: { empCount: number }): { ok: boolean; errors: Array<{ code: string; id?: string | null }> };
  ensureDesks(items: LayoutItem[], ids: string[]): { items: LayoutItem[]; changed: boolean; missing: string[] };
}

let lib: Lib | undefined;
function geometry(): Lib {
  if (!lib) {
    const ctx = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(PKG_ROOT, "web", "layout.js"), "utf8"), ctx, { filename: "layout.js" });
    lib = (ctx as { POLayout: Lib }).POLayout;
  }
  return lib;
}

export type LayoutResult = { ok: true; doc: LayoutDoc } | { ok: false; error: string; codes: string[] };

export class OfficeLayout {
  private file: string;
  doc: LayoutDoc | null = null; // null = the classic layout

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "layout.json");
    const stored = readJsonSafe<unknown>(this.file, () => null, { validate: isObject, label: "layout" });
    if (stored) {
      const r = this.check(stored, []);
      if (r.ok) this.doc = r.doc;
      else console.warn(`[pixel-office] layout: ${this.file} is not a valid layout (${r.error}); using the classic layout`);
    }
  }

  // Schema first (types, ids, bounds, sizes), then the geometry with a desk for every colleague.
  check(input: unknown, empIds: string[]): LayoutResult {
    const g = geometry();
    const s = g.sanitize(input);
    if (!s.ok || !s.items) return { ok: false, error: `schema:${s.error ?? "shape"}`, codes: [] };
    const r = g.check(s.items, { empCount: Math.min(empIds.length, g.MAX_EMP) });
    if (!r.ok) return { ok: false, error: r.errors[0]?.code ?? "invalid", codes: [...new Set(r.errors.map((e) => e.code))] };
    return { ok: true, doc: { v: 1, items: s.items, ...(s.decor ? { decor: true } : {}) } };
  }

  set(doc: LayoutDoc | null) {
    this.doc = doc;
    if (doc) writeJsonAtomicSync(this.file, doc);
    else removeWithBackup(this.file);
  }

  // Everybody gets a desk: spare desks are handed out (and remembered), missing ones added where they fit. True when the layout changed.
  ensure(empIds: string[]): boolean {
    if (!this.doc) return false;
    try {
      const r = geometry().ensureDesks(this.doc.items, empIds);
      if (!r.changed) return false;
      this.set({ ...this.doc, items: r.items }); // (keeps `decor`)
      return true;
    } catch (err) { console.error("[pixel-office] layout: could not add desks:", err); return false; }
  }
}
