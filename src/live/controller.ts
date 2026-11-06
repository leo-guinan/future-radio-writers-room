// Runs one live run inside the server: ticks the state machine, polls the thread, prepares
// scripts, persists state, and puts every step on the station log (so /station/feed/live carries it).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { append } from "../station/log.ts";
import { DATA } from "../station/rules.ts";
import { loadLineup } from "../station/schedule.ts";
import { ahead, extend, newRun, park, setScript, stats, tick, unpark } from "./run.ts";
import { continueRiff, listSegments, opening, rerun, saveSegment, voiceLines } from "./script.ts";
import { FixtureAsk, McpAsk, type AskArchive } from "./ask.ts";
import type { Riff } from "./riff.ts";
import { ArchiveThread, FixtureThread, PushThread, XApiThread, diff, type Snapshot, type ThreadSource } from "./thread.ts";
import type { RunOpts, RunState, Update } from "./types.ts";

const file = () => join(DATA(), "live-run.json");
let run: RunState | null = null;
let source: ThreadSource | null = null;
let last: Snapshot | null = null;
let rootText = "";
let ask: AskArchive | null = null;
const LOOKAHEAD = Number(process.env.LIVE_LOOKAHEAD_SECS ?? 10); // keep this much riff ready ahead of the voice
let timers: NodeJS.Timeout[] = [];
const seen = new Set<string>();

export function current() {
  if (!run && existsSync(file())) run = JSON.parse(readFileSync(file(), "utf8"));
  return run;
}
const save = () => { if (!run) return; run.savedAt = Date.now(); mkdirSync(DATA(), { recursive: true }); writeFileSync(file(), JSON.stringify(run)); };

function makeSource(kind: string, thread: string, fixture?: string): ThreadSource {
  if (kind === "x") return new XApiThread(thread);
  if (kind === "archive") return new ArchiveThread(thread);
  if (kind === "fixture") return FixtureThread.fromFile(fixture ?? process.env.LIVE_FIXTURE ?? "", () => run?.startedAt ?? Date.now());
  return new PushThread();
}

export function queue(u: Update) {
  if (!run || run.phase === "complete" || seen.has(u.id)) return false;
  seen.add(u.id);
  run.queue.push(u);
  append("live.update", { update: u, queued: run.queue.length });
  return true;
}

async function poll() {
  if (!run || !source || run.phase === "complete") return;
  try {
    const snap = await source.snapshot();
    if (!snap) return;
    for (const u of diff(last, snap)) queue(u);
    last = snap;
  } catch (e: any) {
    append("live.error", { error: String(e.message).slice(0, 300) });
  }
}

function makeAsk(fixture?: string): AskArchive | null {
  const f = fixture ?? process.env.LIVE_ASK_FIXTURE;
  if (f) return FixtureAsk.fromFile(f);
  try { return process.env.STATION_ARCHIVE_MCP_URL ? new McpAsk() : null; } catch { return null; }
}

export { listSegments };

/** Keep the riff going: whenever less than LOOKAHEAD seconds are queued, ask the next question. */
function riffLoop(u: Update, riff: Riff, n: number) {
  let busy = false;
  const t = setInterval(async () => {
    const r = run;
    const c = r?.current;
    if (!r || !c || c.n !== n || !c.script) { if (!c || c.n !== n) clearInterval(t); return; }
    if (c.script.done) { clearInterval(t); return; }
    if (busy || ahead(r, Date.now()) > LOOKAHEAD) return;
    busy = true;
    try {
      const lines = await continueRiff(u, riff, r, n);
      extend(r, n, lines, riff.done, Date.now());
      c.script.turns = riff.turns;
      append("live.riff", { run: r.id, n, turn: riff.turns, lines: lines.map((l) => ({ speaker: l.speaker, text: l.text, ask: l.ask })), done: riff.done });
      if (riff.done) { saveSegment(r.id, n, u, c.script, (Date.now() - c.began) / 1000); clearInterval(t); }
      save();
    } catch (e: any) {
      extend(r, n, [], true, Date.now());
      append("live.error", { error: String(e.message) });
    } finally { busy = false; }
  }, 400);
  t.unref?.();
}

export async function start(opts: { thread: string; source: string; library?: string[]; fixture?: string; askFixture?: string; pollSecs?: number }) {
  stop();
  const lineup = loadLineup();
  const lib = (opts.library?.length ? opts.library.map((id) => lineup.programs.find((p) => p.id === id)!).filter(Boolean) : lineup.programs)
    .map((p) => ({ id: p.id, title: p.title, duration: p.duration, media: `/station/media/${p.id}.mp4`, youtube: p.youtube || null }));
  const now = Date.now();
  run = newRun(`R${now.toString(36)}`, opts.thread, lib, now, Number(process.env.LIVE_IDENT_SECS ?? 4));
  run.opts = { source: opts.source, fixture: opts.fixture, askFixture: opts.askFixture, pollSecs: opts.pollSecs };
  last = null; seen.clear();
  append("live.start", { run: run.id, thread: opts.thread, source: opts.source, library: lib.map((p) => p.id), library_secs: stats(run, now).library_secs });
  await attach(run.opts);
  return publicState();
}

/**
 * Pick up a run the server was running before it restarted (or one that was stopped, when
 * `stopped` is true). The program continues from where it was; the time away is off air. Without
 * this the saved run was served with nothing ticking it, and every page sat on "Up next".
 */
export async function resume(o: { stopped?: boolean } = {}) {
  const r = current();
  if (!r || r.phase === "complete" || timers.length) return null;
  if (r.phase === "stopped" && !o.stopped) return null; // stopped on purpose: stays stopped
  const now = Date.now();
  const offSince = r.phase === "stopped" ? r.resumedAt : r.savedAt ?? r.resumedAt;
  park(r, now);
  unpark(r, now, offSince);
  for (const u of r.queue) seen.add(u.id);
  append("live.resume", { run: r.id, thread: r.thread, idx: r.idx, offset: Math.round(r.offset), off_air_secs: Math.round((now - offSince) / 1000) });
  await attach(r.opts ?? { source: "push" });
  return publicState();
}

async function attach(opts: RunOpts) {
  const r = run!;
  source = makeSource(opts.source, r.thread, opts.fixture);
  rootText = (await source.root?.().catch(() => "")) ?? "";
  ask = makeAsk(opts.askFixture);
  save();
  const hooks = {
    prepare: (u: Update, s: RunState) => {
      const n = s.current!.n;
      if (u.type === "reair" && u.segment) {
        // A rerun: the saved segment as it aired, plus one cached announcement. Nothing generated.
        const sc = rerun(u.segment);
        sc.announce = { speaker: "MRS. BUS", text: "From the archive: a rerun.", dur: 0 };
        voiceLines([sc.announce], `L-${s.id}-${String(n).padStart(3, "0")}-r`).then(() => { if (run) { setScript(run, n, sc); save(); } });
        return;
      }
      opening(u, s, n, rootText, ask)
        .then(({ script, riff }) => {
          if (!run) return;
          setScript(run, n, script);
          if (riff && !script.done) riffLoop(u, riff, n);
          else saveSegment(run.id, n, u, script, 0);
          save();
        })
        .catch((e: any) => append("live.error", { error: String(e.message) }));
    },
    onEvent: (type: string, body: Record<string, unknown>) => append(type, { run: run!.id, ...body, state: { ...publicState(), library: undefined } }),
  };
  timers.push(setInterval(() => { if (run && tick(run, Date.now(), hooks)) save(); }, 200));
  timers.push(setInterval(save, 5000)); // heartbeat: a restart resumes within 5 s of where it was
  await poll();
  timers.push(setInterval(poll, (opts.pollSecs ?? Number(process.env.LIVE_POLL_SECS ?? 30)) * 1000));
  for (const t of timers) t.unref?.();
}

/** Stop ticking. The run is parked (frame held, shown as STOPPED) until /api/live/resume or a new start. */
export function stop() {
  const was = timers.length > 0;
  for (const t of timers) clearInterval(t);
  timers = [];
  if (was && run && run.phase !== "complete") { park(run, Date.now()); save(); append("live.stop", { run: run.id, idx: run.idx, offset: Math.round(run.offset) }); }
}

export function publicState() {
  const r = current();
  if (!r) return null;
  const now = Date.now();
  return { now, run: r.id, thread: r.thread, phase: r.phase, idx: r.idx, offset: r.offset, resumedAt: r.resumedAt, ident: r.ident, library: r.library, current: r.current, queued: r.queue.length, done: r.done, stats: stats(r, now) };
}
