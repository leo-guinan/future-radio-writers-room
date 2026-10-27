// The daily production loop: Select → Write → Generate → Review → Publish → Account.
// Small enough to complete repeatedly. Every step leaves a record.

import { readFileSync, existsSync } from "node:fs";
import { sha256 } from "../core/events.ts";
import type { Room } from "../core/room.ts";
import { EPISODE_STAGES, type EpisodeStage } from "../core/types.ts";

export const LOOP: Array<{ stage: EpisodeStage; does: string }> = [
  { stage: "select", does: "Choose the idea(s) and scenes; define the deliverable, quality threshold and budget." },
  { stage: "write", does: "Tight script or beat sheet. Reuse character voices and existing assets." },
  { stage: "generate", does: "Run the minimum necessary audio, music or visual production." },
  { stage: "review", does: "One structured quality pass. Fix blocking defects, not every imperfection." },
  { stage: "publish", does: "Release the finished artifact and invite a specific response." },
  { stage: "account", does: "Record actual cost, elapsed time, revisions, and what should improve next time." },
];

export function fileSha(path: string): string {
  if (!existsSync(path)) throw new Error(`No file at ${path}`);
  return sha256(readFileSync(path));
}

/** The minimum-viable-release checklist, derived from the record rather than ticked by hand. */
export function checklist(room: Room, episodeId: string) {
  const ep = room.mustEpisode(episodeId);
  const reached = (s: EpisodeStage) => EPISODE_STAGES.indexOf(ep.stage) >= EPISODE_STAGES.indexOf(s);
  const selected = [...ep.scenes.values()].filter((s) => s.selected);
  const maxMinutes = selected.reduce((t, s) => t + s.minutes[1], 0);
  const minMinutes = selected.reduce((t, s) => t + s.minutes[0], 0);
  const hasAsset = (k: string) => ep.assets.some((a) => a.kind === k);
  const release = ep.releases.at(-1);
  const hasCash = room.ledger.some((l) => l.episodeId === episodeId && l.unit === "usd" && l.kind === "expense");
  const hasHours = room.episodeHours(episodeId) > 0;
  const scenesKnown = ep.scenes.size > 0;
  return [
    { task: "Choose one clear dramatic spine", done: reached("write") && (!scenesKnown || selected.length > 0) },
    {
      task: `Cut to a feasible runtime (${ep.budget.runtimeMinutes[0]}–${ep.budget.runtimeMinutes[1]} min)`,
      done: scenesKnown ? minMinutes <= ep.budget.runtimeMinutes[1] : reached("write"),
      detail: scenesKnown ? `selected scenes estimate ${minMinutes}–${maxMinutes} min` : undefined,
    },
    { task: "Lock voices and recurring character identities", done: hasAsset("script") },
    { task: "Produce dialogue, music cues and minimal sound design", done: hasAsset("audio") || hasAsset("music") },
    { task: "Listen through once for clarity and defects", done: reached("publish") },
    { task: "Publish with a writers' room invitation", done: !!release },
    { task: "Archive the file, source text, costs and production time", done: reached("account") && hasCash && hasHours && !!release },
  ];
}

export function nextStep(room: Room, episodeId: string) {
  const ep = room.mustEpisode(episodeId);
  const i = EPISODE_STAGES.indexOf(ep.stage);
  return LOOP.find((l) => l.stage === EPISODE_STAGES[i + 1]) ?? null;
}

/** Close the loop: record what it actually cost and what was learned. */
export function account(
  room: Room,
  actor: string,
  episodeId: string,
  a: { cashUsd?: number; cashEvidence?: string; hours: number; who?: string; revisions?: number; learned: string },
) {
  const ep = room.mustEpisode(episodeId);
  if (!ep.releases.length) throw new Error(`${episodeId} has no release to account for.`);
  if (a.cashUsd && a.cashUsd > 0)
    room.addLedgerEntry(actor, {
      ledger: "operations",
      kind: "expense",
      amount: a.cashUsd,
      unit: "usd",
      status: "observed",
      label: `${episodeId} production cash`,
      episodeId,
      evidence: a.cashEvidence,
    });
  room.addLedgerEntry(actor, {
    ledger: "effort",
    kind: "hours",
    amount: a.hours,
    unit: "hours",
    status: "observed",
    label: `${episodeId} production time${a.revisions ? `, ${a.revisions} revisions` : ""}`,
    episodeId,
    who: a.who ?? actor,
  });
  return room.advanceEpisode(actor, episodeId, "account", a.learned);
}
