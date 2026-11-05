// The live-run state machine. Pure apart from the clock and the script-maker, which are injected,
// so the acceptance test can drive a whole run in milliseconds.

import type { Interrupt, Line, PhaseSpan, Program, RunState, Script, Update } from "./types.ts";

export const FREEZE_MIN = 1.5; // s: the frame holds still at least this long before the announcement
export const REACT_MAX = 30; // s: the hard cap on a reaction segment
export const RETURN_SECS = 3; // s: "back to our regularly scheduled programming"
export const GAP = 0.25; // s between lines

export function newRun(id: string, thread: string, library: Program[], now: number, ident = 4): RunState {
  return { id, thread, library, ident, startedAt: now, phase: "playing", idx: 0, offset: 0, resumedAt: now, current: null, queue: [], done: [], completedAt: null };
}

/** Where the program is right now (seconds into library[idx]); frozen during an interrupt. */
export function position(s: RunState, now: number) {
  if (s.phase !== "playing") return { idx: s.idx, offset: s.offset };
  return { idx: s.idx, offset: s.offset + (now - s.resumedAt) / 1000 };
}

/** Fit the reaction into REACT_MAX: in order, skip any line that would overrun and keep trying the
 * (usually shorter) lines after it. A single overlong first line is kept but cut at REACT_MAX. */
export function fit(react: Line[]): Line[] {
  const out: Line[] = [];
  let t = 0;
  for (const l of react) {
    const need = (out.length ? GAP : 0) + l.dur;
    if (t + need > REACT_MAX && out.length) continue;
    out.push(l);
    t += need;
  }
  return out;
}

export function schedule(script: Script, from: number): PhaseSpan[] {
  const react = fit(script.react);
  const ann = script.announce.dur + 0.4;
  const rx = Math.min(REACT_MAX, react.reduce((s, l, i) => s + l.dur + (i ? GAP : 0), 0) + 0.3);
  script.react = react;
  const ret = Math.max(RETURN_SECS, script.returnLine.dur + 0.5);
  const a = from, b = a + ann * 1000, c = b + rx * 1000, d = c + ret * 1000;
  return [
    { phase: "announce", start: a, end: b },
    { phase: "react", start: b, end: c },
    { phase: "return", start: c, end: d },
  ];
}

export interface Hooks { prepare: (u: Update, s: RunState) => void; onEvent?: (type: string, body: Record<string, unknown>) => void }

/** Advance the run to `now`. Returns true when anything changed (for broadcasting). */
export function tick(s: RunState, now: number, h: Hooks): boolean {
  const emit = h.onEvent ?? (() => {});
  let changed = false;
  if (s.phase === "complete") return false;

  if (s.phase === "playing") {
    let { idx, offset } = position(s, now);
    while (idx < s.library.length && offset >= s.library[idx].duration + s.ident) {
      offset -= s.library[idx].duration + s.ident;
      idx++;
      changed = true;
    }
    if (changed) { s.idx = idx; s.offset = offset; s.resumedAt = now; emit("live.program", { idx, title: s.library[idx]?.title ?? null }); }
    if (idx >= s.library.length) {
      s.phase = "complete"; s.completedAt = now; s.idx = s.library.length; s.offset = 0;
      emit("live.complete", stats(s, now));
      return true;
    }
    if (s.queue.length) {
      const update = s.queue.shift()!;
      const n = s.done.length + 1;
      s.idx = idx; s.offset = offset; s.phase = "freeze";
      s.current = { n, update, frozen: { idx, offset }, began: now, phases: [{ phase: "freeze", start: now, end: Infinity }], script: null };
      emit("live.freeze", { n, update, frozen: s.current.frozen });
      h.prepare(update, s);
      return true;
    }
    return changed;
  }

  const c = s.current!;
  if (s.phase === "freeze") {
    if (c.script && now - c.began >= FREEZE_MIN * 1000) {
      c.phases[0].end = now;
      c.phases.push(...schedule(c.script, now));
      s.phase = "announce";
      emit("live.announce", { n: c.n, update_type: c.update.type, script: c.script, phases: c.phases });
      return true;
    }
    return false;
  }
  const span = c.phases.find((p) => p.phase === s.phase)!;
  if (now < span.end) return false;
  const next = c.phases[c.phases.indexOf(span) + 1];
  if (next) {
    s.phase = next.phase;
    emit(`live.${next.phase}`, { n: c.n });
    return true;
  }
  // Back to the program, exactly where it froze.
  c.ended = now;
  s.done.push({ n: c.n, type: c.update.type, user: c.update.user, began: c.began, ended: now });
  s.phase = "playing"; s.idx = c.frozen.idx; s.offset = c.frozen.offset; s.resumedAt = now; s.current = null;
  emit("live.resume", { n: c.n, idx: s.idx, offset: s.offset, took: (now - c.began) / 1000 });
  return true;
}

export function setScript(s: RunState, n: number, script: Script) {
  if (s.current && s.current.n === n) s.current.script = script;
}

/** The energy-to-time ledger. */
export function stats(s: RunState, now: number) {
  const library = s.library.reduce((t, p) => t + p.duration + s.ident, 0);
  const interrupted = s.done.reduce((t, d) => t + (d.ended - d.began) / 1000, 0) + (s.current ? (now - s.current.began) / 1000 : 0);
  const { idx, offset } = position(s, now);
  const played = s.library.slice(0, Math.min(idx, s.library.length)).reduce((t, p) => t + p.duration + s.ident, 0) + (idx < s.library.length ? offset : 0);
  const end = s.completedAt ?? now;
  const byType: Record<string, number> = {};
  for (const d of s.done) byType[d.type] = (byType[d.type] ?? 0) + 1;
  return {
    library_secs: round(library),
    played_secs: round(Math.min(played, library)),
    remaining_secs: round(Math.max(0, library - played)),
    elapsed_secs: round((end - s.startedAt) / 1000),
    added_by_thread_secs: round(interrupted),
    interrupts: s.done.length,
    by_type: byType,
    stretch: round((end - s.startedAt) / 1000 / Math.max(1, Math.min(played, library) || library)),
    complete: s.phase === "complete",
  };
}
const round = (x: number) => Math.round(x * 10) / 10;
