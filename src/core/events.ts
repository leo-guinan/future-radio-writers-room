// Append-only, hash-chained event log stored as JSONL.
// One line per event. Nothing is ever rewritten; corrections are new events.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EventType, RoomEvent, Visibility } from "./types.ts";

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function hashEvent(e: Omit<RoomEvent, "hash">): string {
  return sha256(e.prev + canonical(e));
}

export type Listener = (e: RoomEvent) => void;

export class EventStore {
  private events: RoomEvent[] = [];
  private listeners = new Set<Listener>();

  constructor(readonly path: string | null) {
    if (path && existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      this.events = lines.map((l) => JSON.parse(l) as RoomEvent);
    }
  }

  all(): readonly RoomEvent[] {
    return this.events;
  }

  get head(): string {
    return this.events.at(-1)?.hash ?? "genesis";
  }

  /**
   * Pick up events another process (the CLI, while the server runs) appended to the file.
   * Returns how many new events were loaded.
   */
  sync(): number {
    if (!this.path || !existsSync(this.path)) return 0;
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean);
    const fresh = lines.slice(this.events.length).map((l) => JSON.parse(l) as RoomEvent);
    for (const e of fresh) {
      this.events.push(e);
      for (const l of this.listeners) l(e);
    }
    return fresh.length;
  }

  append<T>(type: EventType, actor: string, payload: T, visibility: Visibility = "public", ts?: string): RoomEvent<T> {
    this.sync();
    const seq = this.events.length + 1;
    const base = {
      seq,
      id: `ev_${String(seq).padStart(6, "0")}`,
      ts: ts ?? new Date().toISOString(),
      type,
      actor,
      visibility,
      payload,
      prev: this.head,
    };
    const event: RoomEvent<T> = { ...base, hash: hashEvent(base) };
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(event) + "\n");
    }
    this.events.push(event as RoomEvent);
    for (const l of this.listeners) l(event as RoomEvent);
    return event;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Recompute the chain. Returns the first broken event, or null if intact. */
  verify(): { ok: true; count: number; head: string } | { ok: false; at: string; reason: string } {
    let prev = "genesis";
    for (const e of this.events) {
      const { hash, ...rest } = e;
      if (e.prev !== prev) return { ok: false, at: e.id, reason: "prev hash does not match previous event" };
      if (hashEvent(rest) !== hash) return { ok: false, at: e.id, reason: "event content was altered" };
      prev = hash;
    }
    return { ok: true, count: this.events.length, head: prev };
  }
}
