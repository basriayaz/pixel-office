// Loads web/office.js (browser code) into a node vm with stub canvas / DOM globals, so the layout logic and the drawing
// calls can be tested without a browser. Every canvas context records its calls into `calls`.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function recorder(calls) {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(_, p) {
      if (p === "createLinearGradient" || p === "createRadialGradient") return () => grad;
      if (p === "measureText") return (s) => ({ width: String(s).length * 5 });
      if (p === "canvas") return { width: 960, height: 544 };
      if (p === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      if (p === Symbol.toPrimitive) return undefined;
      return (...a) => { calls.push([p, ...a.map((x) => (typeof x === "object" && x ? "obj" : x))]); };
    },
    set(_, p, v) { calls.push(["=" + String(p), typeof v === "object" && v ? "obj" : v]); return true; },
  });
}

export function loadOffice({ files = ["web/layout.js", "web/office.js"] } = {}) {
  const calls = [];
  const canvas = () => ({ width: 0, height: 0, style: {}, getContext: () => recorder(calls), addEventListener() {}, toDataURL: () => "data:", parentElement: null, appendChild() {}, classList: { toggle() {}, add() {}, remove() {} } });
  const sandbox = {
    console, performance, setTimeout, clearTimeout, setInterval, clearInterval,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    document: { createElement: canvas, addEventListener() {}, hidden: false },
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame() {}, addEventListener() {}, getComputedStyle: () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0", display: "block" }), devicePixelRatio: 1,
    PO: { strings: {} }, __poHour: 12,
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext("(() => { let s = 12345; Math.random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); globalThis.__reseed = () => { s = 12345; }; })()", ctx);
  // a fixed clock: some props draw the current time
  vm.runInContext("(() => { const R = Date, fixed = new R(2026, 0, 5, 10, 15).getTime(); globalThis.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }; })()", ctx);
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  }
  const run = (code) => vm.runInContext(code, ctx);
  // draw one decor entry with a fresh recording context; returns a short hash of every canvas call it made
  const hashDraw = (fn, t = 1234) => {
    calls.length = 0;
    run("__reseed()");
    fn(recorder(calls), t);
    return createHash("sha1").update(JSON.stringify(calls)).digest("hex").slice(0, 12);
  };
  // a real Office on stub canvas / DOM elements
  const makeOffice = () => {
    const stage = { clientWidth: 1000, clientHeight: 700, querySelector: () => null };
    ctx.__cv = { ...canvas(), parentElement: { parentElement: stage }, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
    ctx.__labels = { innerHTML: "", appendChild() {}, classList: { toggle() {} } };
    return run("new Office(__cv, __labels)");
  };
  return { ctx, run, hashDraw, calls, makeOffice };
}
