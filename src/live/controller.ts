// Runs one live run inside the server: ticks the state machine, polls the thread, prepares
// scripts, persists state, and puts every step on the station log (so /station/feed/live carries it).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { append } from "../station/log.ts";
import { DATA } from "../station/rules.ts";
import { loadLineup } from "../station/schedule.ts";
import { newRun, setScript, stats, tick } from "./run.ts";
import { makeScript } from "./script.ts";
import { ArchiveThread, FixtureThread, PushThread, XApiThread, diff, type Snapshot, type ThreadSource } from "./thread.ts";
import type { RunState, Update } from "./types.ts";

const file = () => join(DATA(), "live-run.json");
let run: RunState | null = null;
let source: ThreadSource | null = null;
let last: Snapshot | null = null;
let rootText = "";
let timers: NodeJS.Timeout[] = [];
const seen = new Set<string>();

export function current() {
  if (!run && existsSync(file())) run = JSON.parse(readFileSync(file(), "utf8"));
  return run;
}
const save = () => { mkdirSync(DATA(), { recursive: true }); writeFileSync(file(), JSON.stringify(run)); };

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

export async function start(opts: { thread: string; source: string; library?: string[]; fixture?: string; pollSecs?: number }) {
  stop();
  const lineup = loadLineup();
  const lib = (opts.library?.length ? opts.library.map((id) => lineup.programs.find((p) => p.id === id)!).filter(Boolean) : lineup.programs)
    .map((p) => ({ id: p.id, title: p.title, duration: p.duration, media: `/station/media/${p.id}.mp4`, youtube: p.youtube || null }));
  const now = Date.now();
  run = newRun(`R${now.toString(36)}`, opts.thread, lib, now, Number(process.env.LIVE_IDENT_SECS ?? 4));
  last = null; seen.clear();
  source = makeSource(opts.source, opts.thread, opts.fixture);
  rootText = (await source.root?.().catch(() => "")) ?? "";
  append("live.start", { run: run.id, thread: opts.thread, source: source.id, library: lib.map((p) => p.id), library_secs: stats(run, now).library_secs });
  save();
  const hooks = {
    prepare: (u: Update, s: RunState) => {
      const n = s.current!.n;
      makeScript(u, s, n, rootText).then((sc) => { if (run) { setScript(run, n, sc); save(); } }).catch((e) => append("live.error", { error: String(e.message) }));
    },
    onEvent: (type: string, body: Record<string, unknown>) => append(type, { run: run!.id, ...body, state: { ...publicState(), library: undefined } }),
  };
  timers.push(setInterval(() => { if (run && tick(run, Date.now(), hooks)) save(); }, 200));
  await poll();
  timers.push(setInterval(poll, (opts.pollSecs ?? Number(process.env.LIVE_POLL_SECS ?? 30)) * 1000));
  for (const t of timers) t.unref?.();
  return publicState();
}

export function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

export function publicState() {
  const r = current();
  if (!r) return null;
  const now = Date.now();
  return { now, run: r.id, thread: r.thread, phase: r.phase, idx: r.idx, offset: r.offset, resumedAt: r.resumedAt, ident: r.ident, library: r.library, current: r.current, queued: r.queue.length, done: r.done, stats: stats(r, now) };
}
