// Capability inventory: what the plan reuses from the writers' room, and what it
// must build. Reuse claims are verified against the repo at runtime — a file that
// isn't there is reported missing, not reused.

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ReuseClaim {
  capability: string;
  source: string;
  evidence: string;
}

export interface BuildNeed {
  capability: string;
  why: string;
}

const REUSABLE: Array<{ capability: string; files: string[]; note: string }> = [
  { capability: "event-store", files: ["src/core/events.ts"], note: "append-only hash-chained JSONL; humain sessions append here" },
  { capability: "character-memory", files: ["src/agents/characters.ts", "characters/borges.md"], note: "memory role retrieves cited archive passages" },
  { capability: "character-making", files: ["src/agents/characters.ts", "characters/leonardo.md"], note: "making role sketches approaches with stopping rules" },
  { capability: "character-accounting", files: ["src/agents/characters.ts", "characters/agnolo.md"], note: "accounting role scores and keeps figures apart" },
  { capability: "production-loop", files: ["src/production/loop.ts"], note: "select→account checklist derived from the record" },
  { capability: "cost-ledger", files: ["src/core/room.ts"], note: "three ledgers; observed/projected/disputed/unknown never blend" },
  { capability: "forecasts", files: ["src/core/room.ts"], note: "estimates booked as forecasts with due dates and resolutions" },
  { capability: "catalog-works", files: ["catalog/works.json"], note: "verified creative works with releases and checksums" },
  { capability: "showrunner-gates", files: ["src/showrunner/gates.ts", "gates.json"], note: "load-tightened gates for candidate selection" },
  { capability: "evidence-checks", files: ["src/production/loop.ts"], note: "fileSha + checklist pattern for verified claims" },
];

const TO_BUILD: BuildNeed[] = [
  { capability: "frame-maker", why: "No page builder exists; the demo's comparison page must be generated." },
  { capability: "visitor-counter", why: "No counter component exists; the vintage odometer is new." },
  { capability: "voice-capture", why: "Mic capture + input window is new HumAIn OS surface (this prototype provides it)." },
];

export function inventory(root = process.cwd()): { reuse: ReuseClaim[]; build: BuildNeed[]; missing: string[] } {
  const reuse: ReuseClaim[] = [];
  const missing: string[] = [];
  for (const r of REUSABLE) {
    const found = r.files.filter((f) => existsSync(join(root, f)));
    if (found.length === r.files.length) reuse.push({ capability: r.capability, source: r.files.join(", "), evidence: r.note });
    else missing.push(`${r.capability} (missing: ${r.files.filter((f) => !found.includes(f)).join(", ")})`);
  }
  // Anything missing falls back to build — the plan says so explicitly.
  const build = [...TO_BUILD, ...missing.map((m) => ({ capability: m, why: "Expected reuse target is absent; must be built or dropped." }))];
  return { reuse, build, missing };
}
