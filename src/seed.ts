// Seed the room from the Artup Production Plan: the season's episodes, Episode 10's
// scene candidates and selection, the deferred branches, and the original forecasts.
// Forecasts are recorded now so the November 30 conference can't quietly rewrite them.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Room } from "./core/room.ts";
import type { EpisodePlanned, IdeaStatus, OutputKind } from "./core/types.ts";

interface Seed {
  source: string;
  ts: string;
  episodes: EpisodePlanned[];
  scenes: Array<{ sceneId: string; title: string; role: string; minutes: [number, number]; core: boolean; selected: boolean; summary: string; question: string }>;
  ideas: Array<{ title: string; question: string; output: OutputKind; episodeId?: string; status: IdeaStatus; reason: string; note?: string }>;
  forecasts: Array<{ claim: string; metric?: string; target?: string; dueBy: string; verbatim: boolean; visibility: "public" | "producer" }>;
}

export function seed(room: Room, actor = "leo", file = join(process.cwd(), "seed", "season-1.json")) {
  if (room.store.all().length) throw new Error("The room already has history. Seeding only happens once, on an empty log.");
  const s = JSON.parse(readFileSync(file, "utf8")) as Seed;
  const ts = s.ts;
  room.lockRules(actor, ts);
  for (const ep of s.episodes) room.planEpisode(actor, ep, ts);
  for (const sc of s.scenes) {
    const { selected: _s, ...scene } = sc;
    room.addScene(actor, { ...scene, episodeId: "E10" }, ts);
  }
  room.advanceEpisode(actor, "E10", "select", "Scene selection from the plan's selection board.", ts);
  for (const sc of s.scenes)
    room.selectScene(
      actor,
      {
        episodeId: "E10",
        sceneId: sc.sceneId,
        selected: sc.selected,
        reason: sc.selected
          ? "Survived the first cut: advances the story, explains the business, or invites participation."
          : "Saved for later: can't be produced tomorrow with negligible incremental effort.",
      },
      ts,
    );
  for (const i of s.ideas) {
    const ev = room.proposeIdea(
      actor,
      {
        title: i.title,
        question: i.question,
        output: i.output,
        source: s.source,
        episodeId: i.episodeId,
        contributor: { name: "Leo", credit: true, reuse: "cc-by" },
      },
      ts,
    );
    const ideaId = (ev.payload as { ideaId: string }).ideaId;
    if (i.status === "selected") {
      room.transitionIdea(actor, { ideaId, to: "selected", reason: i.reason }, ts);
    } else if (i.status !== "proposed") {
      room.transitionIdea(actor, { ideaId, to: i.status, reason: i.reason }, ts);
    }
    if (i.note) room.note(actor, ideaId, i.note);
  }
  for (const f of s.forecasts) {
    const { visibility, ...rest } = f;
    room.recordForecast(actor, { ...rest, source: s.source }, visibility, ts);
  }
  return room.store.all().length;
}
