// The live-run state machine. Pure apart from the clock and the script-maker, which are injected,
// so the acceptance test can drive a whole run in milliseconds.
//
// The reaction is a generated segment, not a fixed clip: lines are appended while it plays
// (extend), and it ends when the riff wraps (done). RIFF_LIMIT is a safety ceiling, not a format.

import type { Interrupt, Line, PhaseSpan, Program, RunState, Script, Update } from "./types.ts";

export const FREEZE_MIN = 1.5; // s: the frame holds still at least this long before the announcement
export const RIFF_LIMIT = Number(process.env.LIVE_RIFF_LIMIT_SECS ?? 600); // s: safety ceiling on one segment
export const RETURN_SECS = 3; // s: "back to our regularly scheduled programming"
export const GAP = 0.3; // s between lines

export function newRun(id: string, thread: string, library: Program[], now: number, ident = 4): RunState {
  return { id, thread, library, ident, startedAt: now, phase: "playing", idx: 0, offset: 0, resumedAt: now, current: null, queue: [], done: [], completedAt: null };
}

/** Where the program is right now (seconds into library[idx]); frozen during an interrupt. */
export function position(s: RunState, now: number) {
  if (s.phase !== "playing") return { idx: s.idx, offset: s.offset };
  return { idx: s.idx, offset: s.offset + (now - s.resumedAt) / 1000 };
}

const lastEnd = (lines: Line[], from: number) => lines.reduce((t, l) => Math.max(t, (l.at ?? from) + l.dur * 1000), from);

/** Place lines one after another, never before `now`. */
function place(lines: Line[], after: number, now: number) {
  let t = after;
  for (const l of lines) {
    if (l.at == null) l.at = Math.max(t, now);
    t = l.at + (l.dur + GAP) * 1000;
  }
  return t;
}

function close(c: Interrupt, now: number) {
  const react = c.phases.find((p) => p.phase === "react")!;
  const end = Math.max(now, lastEnd(c.script!.react, react.start) + 300);
  react.end = Math.min(end, react.start + RIFF_LIMIT * 1000);
  const ret = Math.max(RETURN_SECS, c.script!.returnLine.dur + 0.5);
  c.script!.returnLine.at = react.end;
  c.phases.push({ phase: "return", start: react.end, end: react.end + ret * 1000 });
}

export function schedule(script: Script, from: number): PhaseSpan[] {
  const ann = script.announce.dur + 0.4;
  script.announce.at = from;
  const b = from + ann * 1000;
  place(script.react, b, b);
  return [
    { phase: "announce", start: from, end: b },
    { phase: "react", start: b, end: Infinity }, // open until the riff wraps
  ];
}

export interface Hooks { prepare: (u: Update, s: RunState) => void; onEvent?: (type: string, body: Record<string, unknown>) => void }

/** Advance the run to `now`. Returns true when anything changed (for broadcasting). */
export function tick(s: RunState, now: number, h: Hooks): boolean {
  const emit = h.onEvent ?? (() => {});
  let changed = false;
  if (s.phase === "complete" || s.phase === "stopped") return false;

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
      if (c.script.done) close(c, now);
      s.phase = "announce";
      emit("live.announce", { n: c.n, update_type: c.update.type });
      return true;
    }
    return false;
  }
  const span = c.phases.find((p) => p.phase === s.phase)!;
  if (s.phase === "react" && !c.script!.done && now - span.start >= RIFF_LIMIT * 1000) {
    c.script!.done = true; // the safety ceiling: wrap whatever is playing
    c.script!.react = c.script!.react.filter((l) => (l.at ?? 0) < now);
    close(c, now);
    emit("live.limit", { n: c.n });
  }
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

/** The segment's first lines are ready: the freeze can end. */
export function setScript(s: RunState, n: number, script: Script) {
  if (s.current && s.current.n === n) s.current.script = script;
}

/** More of the riff is ready: schedule it after what is already queued; `done` wraps the segment. */
export function extend(s: RunState, n: number, lines: Line[], done: boolean, now: number) {
  const c = s.current;
  if (!c || c.n !== n || !c.script || c.script.done) return;
  c.script.react.push(...lines);
  const react = c.phases.find((p) => p.phase === "react");
  if (react) place(lines, lastEnd(c.script.react.filter((l) => !lines.includes(l)), react.start) + GAP * 1000, now);
  if (done) { c.script.done = true; if (react) close(c, now); }
}

/** Seconds of riff already scheduled but not yet heard: the generator works ahead of the voice. */
export function ahead(s: RunState, now: number) {
  const c = s.current;
  if (!c?.script) return Infinity;
  const react = c.phases.find((p) => p.phase === "react");
  if (!react) return c.script.react.reduce((t, l) => t + l.dur, 0);
  return Math.max(0, (lastEnd(c.script.react, react.start) - now) / 1000);
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
    elapsed_secs: round((end - s.startedAt) / 1000 - (s.offAirSecs ?? 0)),
    added_by_thread_secs: round(interrupted),
    interrupts: s.done.length,
    by_type: byType,
    complete: s.phase === "complete",
  };
}
const round = (x: number) => Math.round(x * 10) / 10;

/** Take the run off the air at `now`: the program holds its frame and an unfinished interruption
 *  goes back to the front of the queue (its script was lost with the old process). */
export function park(s: RunState, now: number) {
  if (s.phase === "complete") return;
  if (s.current) {
    s.queue.unshift(s.current.update);
    s.idx = s.current.frozen.idx; s.offset = s.current.frozen.offset; s.current = null;
  } else if (s.phase === "playing") {
    const p = position(s, s.savedAt && s.savedAt < now ? s.savedAt : now);
    s.idx = p.idx; s.offset = p.offset;
  }
  s.phase = "stopped"; s.resumedAt = now;
}

/** Back on the air: playing from the parked frame; the time away is not broadcast time. */
export function unpark(s: RunState, now: number, offSince: number) {
  if (s.phase !== "stopped") return;
  s.offAirSecs = (s.offAirSecs ?? 0) + Math.max(0, now - offSince) / 1000;
  s.phase = "playing"; s.resumedAt = now;
}
