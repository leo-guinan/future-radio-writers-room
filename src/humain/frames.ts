// Persistent frame registry. Frames outlive the disposable workspace: each frame
// is a directory with its page, metadata, and classified visit counts: human
// views, unique visitors (by visitor hash), and automated verification views.
// Shareable at GET /api/humain/frames/:id. Counts are operational data in a
// sidecar file (one event per visit would spam the log); totals are snapshotted
// into frame/checkpoint events.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../core/events.ts";

export const FRAMES_ROOT = () => join(process.env.DATA_DIR ?? join(process.cwd(), "data"), "humain", "frames");

export interface FrameMeta {
  frameId: string;
  sessionId: string;
  hook: string;
  workA: string;
  workB: string;
  createdAt: string;
  sha256: string;
  bytes: number;
}

const ID = /^F-[0-9]{4}$/;

export function assertFrameId(frameId: string): void {
  if (!ID.test(frameId)) throw new Error(`Bad frame id: ${frameId}`);
}

function dir(frameId: string): string {
  assertFrameId(frameId);
  return join(FRAMES_ROOT(), frameId);
}

export function nextFrameId(): string {
  const root = FRAMES_ROOT();
  let max = 0;
  if (existsSync(root))
    for (const name of readdirSync(root)) {
      const m = name.match(/^F-([0-9]{4})$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  return `F-${String(max + 1).padStart(4, "0")}`;
}

/** Publish (or republish) a frame page. Returns metadata with a content hash. */
export function publishFrame(frameId: string, sessionId: string, hook: string, workA: string, workB: string, html: string): FrameMeta {
  const d = dir(frameId);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "index.html"), html);
  const bytes = Buffer.byteLength(html);
  const hash = sha256(html);
  const meta: FrameMeta = { frameId, sessionId, hook, workA, workB, createdAt: new Date().toISOString(), sha256: hash, bytes };
  writeFileSync(join(d, "meta.json"), JSON.stringify(meta, null, 2));
  if (!existsSync(join(d, "visits.json")))
    writeFileSync(join(d, "visits.json"), JSON.stringify({ humanViews: 0, uniqueVisitors: 0, verificationViews: 0, visitors: {} } satisfies VisitsFile));
  return meta;
}

export interface VisitCounts {
  human: number; // human views (refreshes count; verification never lands here)
  unique: number; // distinct visitor hashes seen
  verification: number; // automated verification views, tracked separately
}

interface VisitsFile {
  humanViews: number;
  uniqueVisitors: number;
  verificationViews: number;
  visitors: Record<string, number>;
}

const ZERO_COUNTS: VisitCounts = { human: 0, unique: 0, verification: 0 };

function readCounts(d: string): { counts: VisitCounts; visitors: Record<string, number> } {
  try {
    const raw = JSON.parse(readFileSync(join(d, "visits.json"), "utf8")) as Partial<VisitsFile> & { visits?: number };
    if (typeof raw.humanViews === "number") {
      return {
        counts: {
          human: raw.humanViews || 0,
          unique: raw.uniqueVisitors || 0,
          verification: raw.verificationViews || 0,
        },
        visitors: raw.visitors ?? {},
      };
    }
    // Legacy {visits} sidecar: all past views count as human; uniqueness unknown.
    if (typeof raw.visits === "number") return { counts: { human: raw.visits || 0, unique: 0, verification: 0 }, visitors: {} };
  } catch {}
  return { counts: { ...ZERO_COUNTS }, visitors: {} };
}

function writeCounts(d: string, counts: VisitCounts, visitors: Record<string, number>): void {
  const file: VisitsFile = { humanViews: counts.human, uniqueVisitors: counts.unique, verificationViews: counts.verification, visitors };
  writeFileSync(join(d, "visits.json"), JSON.stringify(file));
}

export function readFrame(frameId: string): { meta: FrameMeta; html: string; counts: VisitCounts } {
  const d = dir(frameId);
  if (!existsSync(join(d, "index.html"))) throw new Error(`No frame ${frameId}.`);
  const meta = JSON.parse(readFileSync(join(d, "meta.json"), "utf8")) as FrameMeta;
  const html = readFileSync(join(d, "index.html"), "utf8");
  return { meta, html, counts: readCounts(d).counts };
}

/** Inject live counts into the page's server-count spans (pages published
 * before the spans existed serve unchanged). */
export function injectCounts(html: string, counts: VisitCounts): string {
  return html
    .replace(/data-c="human">\d+</, `data-c="human">${counts.human}<`)
    .replace(/data-c="unique">\d+</, `data-c="unique">${counts.unique}<`)
    .replace(/data-c="verify">\d+</, `data-c="verify">${counts.verification}<`);
}

/**
 * Serve a frame: classify and count the view, return the page with live counts.
 * - verify: true records an automated verification view (never a human one).
 * - visitor: a visitor hash; first sightings increment uniques, repeats don't.
 */
export function serveFrame(frameId: string, opts: { visitor?: string; verify?: boolean } = {}): { html: string; counts: VisitCounts; meta: FrameMeta } {
  const { meta, html } = readFrame(frameId);
  const d = dir(frameId);
  const { counts, visitors } = readCounts(d);
  if (opts.verify) {
    counts.verification++;
  } else {
    counts.human++;
    if (opts.visitor) {
      if (!visitors[opts.visitor]) counts.unique++;
      visitors[opts.visitor] = (visitors[opts.visitor] ?? 0) + 1;
    }
  }
  writeCounts(d, counts, visitors);
  return { html: injectCounts(html, counts), counts: { ...counts }, meta };
}

/** Read a frame's page without counting a visit. Automated verification uses
 * this so checks never inflate visitor counts. */
export function peekFrame(frameId: string): { html: string; counts: VisitCounts; meta: FrameMeta } {
  const { meta, html, counts } = readFrame(frameId);
  return { html, counts, meta };
}

const LOCK_WAIT_MS = 5000;

function withRegistryLock<T>(fn: () => T): T {
  const root = FRAMES_ROOT();
  mkdirSync(root, { recursive: true });
  const lock = join(root, ".lock");
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break; // atomic acquire
    } catch {
      // Lock held: steal it only when demonstrably stale.
      try {
        const raw = readFileSync(join(lock, "owner.json"), "utf8");
        const owner = JSON.parse(raw) as { pid: number; at: number };
        if (Date.now() - owner.at > 10000) {
          try {
            process.kill(owner.pid, 0);
          } catch {
            rmSync(lock, { recursive: true, force: true });
            continue;
          }
        }
      } catch {}
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error("Frame registry is busy; try again.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Atomically allocate n frame ids. Reserved ids exist as directories so a
 * concurrent session can never be handed the same id (gaps possible, collisions
 * impossible). */
export function allocateFrameIds(n: number): string[] {
  if (!(n >= 1)) return [];
  return withRegistryLock(() => {
    const first = nextFrameId();
    const base = Number(first.slice(2));
    const ids = Array.from({ length: n }, (_, i) => `F-${String(base + i).padStart(4, "0")}`);
    for (const id of ids) mkdirSync(dir(id), { recursive: true }); // reservation marker
    return ids;
  });
}

export function listFrames(): Array<FrameMeta & { counts: VisitCounts }> {
  const root = FRAMES_ROOT();
  if (!existsSync(root)) return [];
  const out: Array<FrameMeta & { counts: VisitCounts }> = [];
  for (const name of readdirSync(root).sort()) {
    if (!ID.test(name)) continue;
    try {
      const { meta, counts } = readFrame(name);
      out.push({ ...meta, counts });
    } catch {}
  }
  return out;
}
