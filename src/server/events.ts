import path from "node:path";
import { appendJsonLineSync, readJsonLines } from "./fsutil.js";

// The office's activity log: what happened, who did it, in one line each. The boss reads it as "what went on while I was away".
export type EventKind =
  | "task_created" | "task_status" | "task_owner" | "task_started" | "task_edited"
  | "idea_new" | "idea_promoted" | "idea_edited" | "pm_woken" | "discovery_start" | "discovery_end"
  | "mode_change" | "cap_reached" | "cap_changed"
  | "emp_error" | "emp_sick" | "emp_retry" | "ask" | "question"
  | "meeting_start" | "meeting_end" | "hired" | "fired" | "server_start" | "run_end";

export interface OfficeEvent {
  id: number;
  ts: number;
  kind: EventKind;
  emp?: string;
  empName?: string;
  task?: number;
  taskTitle?: string;
  idea?: number;
  by?: string;      // "user" | employee id | "office"
  byName?: string;
  data?: Record<string, unknown>;
}

const KEEP = 5000; // in memory; the file keeps everything

export class EventLog {
  private file: string;
  private list: OfficeEvent[];
  private next: number;

  constructor(dir: string) {
    this.file = path.join(dir, "events.jsonl");
    const all = readJsonLines<OfficeEvent>(this.file, (e) => typeof e.id === "number" && typeof e.ts === "number" && typeof e.kind === "string");
    this.list = all.slice(-KEEP);
    this.next = all.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  }

  add(ev: Omit<OfficeEvent, "id" | "ts">): OfficeEvent {
    const full: OfficeEvent = { id: this.next++, ts: Date.now(), ...ev };
    for (const k of Object.keys(full) as Array<keyof OfficeEvent>) if (full[k] === undefined) delete full[k];
    appendJsonLineSync(this.file, full);
    this.list.push(full);
    if (this.list.length > KEEP * 1.2) this.list.splice(0, this.list.length - KEEP);
    return full;
  }

  // Newest first.
  since(ts: number, limit: number): OfficeEvent[] {
    const out: OfficeEvent[] = [];
    for (let i = this.list.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.list[i].ts <= ts) break;
      out.push(this.list[i]);
    }
    return out;
  }
}
