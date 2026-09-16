// Fails if any locale is missing a key that en.json has (or has an extra one).
import fs from "node:fs";
import path from "node:path";
const dir = path.resolve(import.meta.dirname, "..", "locales");
const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
const en = new Set(flat(JSON.parse(fs.readFileSync(path.join(dir, "en.json"), "utf8"))));
let bad = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "en.json")) {
  const keys = new Set(flat(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))));
  for (const k of en) if (!keys.has(k)) { console.error(`${f}: missing ${k}`); bad++; }
  for (const k of keys) if (!en.has(k)) { console.error(`${f}: extra ${k}`); bad++; }
}
if (bad) process.exit(1);
console.log("locales ok");
