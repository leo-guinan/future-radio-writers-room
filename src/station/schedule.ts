// The 24-hour grid: the program list loops forever, anchored to a fixed instant, so every
// viewer anywhere computes the same "now playing" from the clock alone. No server state.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Program { id: string; title: string; file: string; youtube: string; duration: number }
export interface Lineup { name: string; tz: string; anchor: string; ident_secs: number; programs: Program[] }
export interface Slot { program: Program; start: number; end: number } // epoch seconds

export const ROOT = process.cwd();
export function loadLineup(path = process.env.STATION_PROGRAMS ?? join(ROOT, "station/programs.json")): Lineup {
  const l = JSON.parse(readFileSync(path, "utf8")) as Lineup;
  if (!l.programs?.length) throw new Error("station: no programs");
  return l;
}

const cycle = (l: Lineup) => l.programs.reduce((s, p) => s + p.duration + l.ident_secs, 0);

/** The slot on air at epoch-second t, and how far into it we are. */
export function onAir(l: Lineup, t: number): { slot: Slot; offset: number; ident: boolean } {
  const a = Date.parse(l.anchor) / 1000;
  const c = cycle(l);
  const k = Math.floor((t - a) / c);
  let s = a + k * c;
  for (const p of l.programs) {
    const end = s + p.duration;
    if (t < end + l.ident_secs) return { slot: { program: p, start: s, end }, offset: t - s, ident: t >= end };
    s = end + l.ident_secs;
  }
  throw new Error("unreachable");
}

/** Every slot that overlaps [from, from + hours). */
export function grid(l: Lineup, from: number, hours = 24): Slot[] {
  const out: Slot[] = [];
  let t = onAir(l, from).slot.start;
  const stop = from + hours * 3600;
  while (t < stop) {
    const { slot } = onAir(l, t + 0.001);
    out.push(slot);
    t = slot.end + l.ident_secs;
  }
  return out;
}
