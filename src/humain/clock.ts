// Trusted monotonic clock for HumAIn OS deadlines.
//
// Wall time can jump (NTP, sleep, user edits). Deadlines are enforced against a
// monotonic counter instead; ISO timestamps are display copies only.

/** Milliseconds on a monotonic counter. Never goes backwards. */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** A deadline enforced outside any model prompt. */
export class Deadline {
  private constructor(readonly atMonoMs: number, readonly atWallIso: string) {}

  static in(ms: number): Deadline {
    if (!(ms > 0) || !Number.isFinite(ms)) throw new Error("A deadline needs a positive duration.");
    return new Deadline(monotonicMs() + ms, new Date(Date.now() + ms).toISOString());
  }

  /** Rebuild from a stored wall timestamp (e.g. after a restart). Conservative: already-passed stays passed. */
  static fromWallIso(iso: string): Deadline {
    const remaining = Date.parse(iso) - Date.now();
    return new Deadline(monotonicMs() + Math.max(0, remaining), iso);
  }

  expired(): boolean {
    return monotonicMs() >= this.atMonoMs;
  }

  remainingMs(): number {
    return Math.max(0, this.atMonoMs - monotonicMs());
  }
}
