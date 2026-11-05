// The station's own append-only log (DATA_DIR/station/events.jsonl) and its live listeners.
// Everything the station does lands here; the open feeds are views of it.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./rules.ts";

export interface StationEvent { seq: number; t: string; type: string; [k: string]: unknown }
type Listener = (e: StationEvent) => void;
const listeners = new Set<Listener>();
let cache: StationEvent[] | null = null;

const file = () => join(DATA(), "events.jsonl");
export function events(): StationEvent[] {
  if (!cache) cache = existsSync(file()) ? readFileSync(file(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return cache;
}
export function append(type: string, body: Record<string, unknown>): StationEvent {
  const all = events();
  const e: StationEvent = { seq: (all.at(-1)?.seq ?? 0) + 1, t: new Date().toISOString(), type, ...body };
  mkdirSync(DATA(), { recursive: true });
  appendFileSync(file(), JSON.stringify(e) + "\n");
  all.push(e);
  for (const l of listeners) l(e);
  return e;
}
export function listen(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function resetCache() { cache = null; }
