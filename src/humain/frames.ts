// Persistent frame registry. Frames outlive the disposable workspace: each frame
// is a directory with its page, metadata, and an independent visit count.
// Shareable at GET /api/humain/frames/:id. Visit counts are operational data in
// a sidecar file (one event per visit would spam the log); totals are snapshotted
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
  if (!existsSync(join(d, "visits.json"))) writeFileSync(join(d, "visits.json"), JSON.stringify({ visits: 0 }));
  return meta;
}

export function readFrame(frameId: string): { meta: FrameMeta; html: string; visits: number } {
  const d = dir(frameId);
  if (!existsSync(join(d, "index.html"))) throw new Error(`No frame ${frameId}.`);
  const meta = JSON.parse(readFileSync(join(d, "meta.json"), "utf8")) as FrameMeta;
  const html = readFileSync(join(d, "index.html"), "utf8");
  let visits = 0;
  try {
    visits = Number((JSON.parse(readFileSync(join(d, "visits.json"), "utf8")) as { visits: number }).visits) || 0;
  } catch {}
  return { meta, html, visits };
}

/** Serve a frame: returns the page and increments its independent visit count. */
export function serveFrame(frameId: string): { html: string; visits: number; meta: FrameMeta } {
  const { meta, html, visits } = readFrame(frameId);
  const n = visits + 1;
  writeFileSync(join(dir(frameId), "visits.json"), JSON.stringify({ visits: n }));
  return { html, visits: n, meta };
}

/** Read a frame's page without counting a visit. Automated verification uses
 * this so checks never inflate visitor counts. */
export function peekFrame(frameId: string): { html: string; visits: number; meta: FrameMeta } {
  const { meta, html, visits } = readFrame(frameId);
  return { html, visits, meta };
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

export function listFrames(): Array<FrameMeta & { visits: number }> {
  const root = FRAMES_ROOT();
  if (!existsSync(root)) return [];
  const out: Array<FrameMeta & { visits: number }> = [];
  for (const name of readdirSync(root).sort()) {
    if (!ID.test(name)) continue;
    try {
      const { meta, visits } = readFrame(name);
      out.push({ ...meta, visits });
    } catch {}
  }
  return out;
}
