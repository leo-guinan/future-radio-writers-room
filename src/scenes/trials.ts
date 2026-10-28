// Blind tastings. The same card (or a whole episode of cards) is played by different model
// line-ups. The results are shown side by side as A, B, C… with nothing that says which model
// played whom: the runs stay producer-only and out of the dressing rooms until the tasting is
// revealed. People pick a favourite and, per character, where that character sounded most like
// themselves. Revealing publishes the line-ups with the tally and cost, and the model report
// adds every revealed tasting up, so casting decisions rest on blind judgments.

import { readFileSync } from "node:fs";
import type { Room, Scene, Trial } from "../core/room.ts";
import { RuleError } from "../core/room.ts";
import { modelFor, roleOf } from "../core/cast.ts";
import type { AgentRun } from "../core/types.ts";
import { DEFAULT_MODEL } from "../agents/llm.ts";
import { dressingRoom, reposEnabled } from "../repos/dressing-room.ts";
import { closeScene, nameIn, openScene, runScene, sceneMarkdown, transcript, type CastMember, type SceneContext } from "./scenes.ts";

export interface CardCast extends CastMember {
  model?: string;
  name?: string;
  persona?: string;
}

export interface SceneCard {
  title: string;
  setting: string;
  situation: string;
  stakes: string;
  stoppingRule: string;
  maxTurns?: number;
  revealMotivations?: boolean;
  episodeId?: string;
  ideaId?: string;
  directorModel?: string;
  cast: CardCast[];
}

/** Model per character slug, role ("memory"…), "director"/"showrunner", or "default". */
export interface Lineup {
  name?: string;
  models: Record<string, string>;
}

/** An episode: scenes played in order, each with the earlier ones in mind. */
export interface EpisodeCards {
  title: string;
  question?: string;
  episodeId?: string;
  ideaId?: string;
  guests?: Record<string, { name: string; persona: string }>;
  scenes: SceneCard[];
  lineups?: Lineup[];
}

/** Read a card file: one scene card, or an episode of them. */
export function loadCards(path: string): EpisodeCards {
  const f = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(f.scenes) ? f : { title: f.title, scenes: [f], lineups: f.lineups, episodeId: f.episodeId, ideaId: f.ideaId };
}

const resolve = (lineup: Lineup | undefined, slug: string): string | undefined => {
  const m = lineup?.models ?? {};
  const role = slug === "director" ? "showrunner" : roleOf(slug);
  return m[slug] ?? (role ? m[role] : undefined) ?? (slug === "director" ? m.assembly : undefined) ?? m.default;
};

/** The concrete model each character (and the director) will run on under a line-up. */
export function castingFor(ep: EpisodeCards, lineup?: Lineup): Record<string, string> {
  const slugs = new Set(ep.scenes.flatMap((s) => s.cast.map((c) => c.character)));
  const out: Record<string, string> = {};
  for (const slug of slugs) out[slug] = resolve(lineup, slug) ?? modelFor(slug) ?? DEFAULT_MODEL();
  out.director = resolve(lineup, "director") ?? modelFor("showrunner") ?? DEFAULT_MODEL();
  return out;
}

/** Play every scene of an episode in order. Returns the scene ids. */
export async function playEpisode(ctx: SceneContext, ep: EpisodeCards, opts: { lineup?: Lineup; trialId?: string } = {}): Promise<string[]> {
  const ids: string[] = [];
  const casting = opts.lineup ? castingFor(ep, opts.lineup) : null;
  for (const card of ep.scenes) {
    const { cast, ...rest } = card;
    const members = cast.map((c) => ({
      ...c,
      ...(ep.guests?.[c.character] && !c.persona ? ep.guests[c.character] : {}),
      ...(casting ? { model: casting[c.character] } : {}),
    }));
    const s = openScene(
      ctx,
      {
        ...rest,
        episodeId: card.episodeId ?? ep.episodeId,
        ideaId: card.ideaId ?? ep.ideaId,
        after: [...ids],
        ...(casting ? { directorModel: casting.director } : {}),
        ...(opts.trialId ? { trialId: opts.trialId } : {}),
      },
      members,
    );
    ids.push(s.sceneId);
    await runScene(ctx, s.sceneId);
  }
  return ids;
}

const LABELS = "ABCDEFGHIJ";

function shuffle<T>(xs: T[], rand = Math.random): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Play the cards under each line-up, in shuffled order so neither labels nor scene ids give the
 * line-ups away, and open a blind tasting of the results.
 */
export async function runTrial(
  ctx: SceneContext,
  ep: EpisodeCards,
  lineups: Lineup[] = ep.lineups ?? [],
  opts: { rand?: () => number; parallel?: boolean } = {},
): Promise<Trial> {
  if (lineups.length < 2) throw new RuleError("trial", "A tasting needs at least two line-ups.");
  if (lineups.length > LABELS.length) throw new RuleError("trial", `At most ${LABELS.length} line-ups.`);
  const trialId = ctx.room.nextTrialId();
  const order = shuffle(lineups, opts.rand).map((l, i) => ({ label: LABELS[i], lineup: l }));
  const play = (o: (typeof order)[number]) => playEpisode(ctx, ep, { lineup: o.lineup, trialId });
  const sceneIds = opts.parallel === false ? await sequential(order, play) : await Promise.all(order.map(play));
  const characters = [...new Set(ep.scenes.flatMap((s) => s.cast.map((c) => c.character)))];
  ctx.room.openTrial(
    ctx.askedBy,
    {
      trialId,
      title: ep.title,
      question: ep.question ?? "Which version would you put on air?",
      entries: order.map((o, i) => ({ label: o.label, sceneIds: sceneIds[i] })),
      characters,
    },
    Object.fromEntries(order.map((o) => [o.label, { ...(o.lineup.name ? { name: o.lineup.name } : {}), models: castingFor(ep, o.lineup) }])),
  );
  return ctx.room.mustTrial(trialId);
}

async function sequential<T, R>(xs: T[], f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const x of xs) out.push(await f(x));
  return out;
}

/**
 * Unblind. Publishes the line-ups and tally, then gives each character's runs to their dressing
 * room, now that knowing the model can't sway anyone.
 */
export function revealTrial(ctx: SceneContext, trialId: string) {
  const ev = ctx.room.revealTrial(ctx.askedBy, trialId);
  const t = ctx.room.mustTrial(trialId);
  if (reposEnabled()) {
    for (const e of t.entries)
      for (const id of e.sceneIds) {
        const s = ctx.room.mustScene(id);
        for (const turn of s.turns) {
          if (s.guests?.[turn.character]) continue;
          const run = ctx.room.runs.get(turn.runId);
          const runEv = ctx.room.store.all().find((x) => x.type === "agent.run" && (x.payload as AgentRun).runId === turn.runId);
          if (!run || !runEv) continue;
          const room = dressingRoom(turn.character);
          const { sha, file } = room.recordRun(run, runEv.ts, runEv.id, runEv.hash);
          ctx.room.store.append("repo.commit", turn.character, { repo: room.repo.name, sha, message: `${run.runId} (${trialId} ${e.label}, revealed)`, files: [file], runId: run.runId, episodeId: run.episodeId }, "public");
        }
      }
  }
  return ev;
}

/** The tasting as one document: blind until revealed, then with line-ups and the tally. */
export function trialMarkdown(room: Room, trialId: string): string {
  const t = room.mustTrial(trialId);
  const scenesOf = (label: string) => t.entries.find((e) => e.label === label)!.sceneIds.map((id) => room.mustScene(id));
  const out: string[] = [`# ${t.trialId} — ${t.title}`, "", `_${t.question}_`, ""];
  if (!t.revealed) out.push("Blind: the versions are labelled, not named. Which models played whom is revealed when the tasting closes.", "");
  for (const e of t.entries) {
    out.push(`## Version ${e.label}`, "");
    if (t.revealed) {
      const l = t.revealed.lineups[e.label];
      const r = t.revealed.tally[e.label];
      out.push(`${l.name ? `**${l.name}.** ` : ""}${Object.entries(l.models).map(([k, m]) => `${k}: \`${m}\``).join(" · ")}`, "");
      out.push(`Favourite of ${r.favorite} · ${Object.entries(r.mostThemselves).map(([c, n]) => `${c} most themselves ×${n}`).join(", ") || "no character votes"} · ${r.lines} lines · ${r.costUsd === null ? "cost unknown" : `$${r.costUsd.toFixed(4)}`}`, "");
    }
    for (const s of scenesOf(e.label)) out.push(`### ${s.title}`, "", ...s.turns.flatMap((x) => [...(x.cue ? [x.cue, ""] : []), `**${nameIn(s, x.character).toUpperCase()}:** ${x.line}`, ""]));
  }
  if (t.feedback.length) {
    out.push("## What people said", "");
    for (const f of t.feedback) out.push(`- **${f.by.replace(/^patron:/, "")}** liked ${f.favorite}${f.note ? `: ${f.note}` : ""}`);
    out.push("");
  }
  return out.join("\n");
}

export function publicTrial(room: Room, t: Trial) {
  return {
    trialId: t.trialId,
    title: t.title,
    question: t.question,
    openedAt: t.openedAt,
    characters: t.characters.map((c) => {
      const s = t.entries[0].sceneIds.map((id) => room.mustScene(id)).find((x) => x.cast.includes(c));
      return { character: c, name: s ? nameIn(s, c) : c };
    }),
    entries: t.entries.map((e) => ({
      label: e.label,
      scenes: e.sceneIds.map((id) => {
        const s = room.mustScene(id);
        return { title: s.title, closed: !!s.closed, turns: s.turns.map((x) => ({ n: x.n, character: x.character, name: nameIn(s, x.character), line: x.line, cue: x.cue })) };
      }),
    })),
    responses: t.feedback.length,
    feedback: t.feedback.map((f) => ({ name: f.by.replace(/^patron:/, ""), favorite: f.favorite, note: f.note ?? null })),
    revealed: t.revealed ? { at: t.revealed.at, lineups: t.revealed.lineups, tally: t.revealed.tally } : null,
  };
}

export interface ModelRow {
  character: string;
  model: string;
  tastings: number; // revealed tastings where this model played this character (in at least one version)
  versions: number; // versions across those tastings
  mostThemselves: number; // votes that this was where the character sounded most like themselves
  votes: number; // all "most themselves" votes cast for this character in those tastings
  favoriteShare: number; // share of favourite votes, in those tastings, won by versions with this casting
}

/** Every revealed tasting, added up per character and model. */
export function modelReport(room: Room): ModelRow[] {
  const rows = new Map<string, ModelRow & { favWon: number; favAll: number }>();
  for (const t of room.trials.values()) {
    if (!t.revealed) continue;
    for (const c of t.characters) {
      const votesForC = t.feedback.filter((f) => f.mostThemselves?.[c]).length;
      const seen = new Set<string>();
      for (const [label, l] of Object.entries(t.revealed.lineups)) {
        const model = l.models[c];
        if (!model) continue;
        const key = `${c}\u0000${model}`;
        const r = rows.get(key) ?? { character: c, model, tastings: 0, versions: 0, mostThemselves: 0, votes: 0, favoriteShare: 0, favWon: 0, favAll: 0 };
        if (!seen.has(key)) {
          // Count the tasting, its votes and its responses once, however many versions shared this casting.
          seen.add(key);
          r.tastings++;
          r.votes += votesForC;
          r.favAll += t.feedback.length;
        }
        r.versions++;
        r.mostThemselves += t.revealed.tally[label].mostThemselves[c] ?? 0;
        r.favWon += t.revealed.tally[label].favorite;
        rows.set(key, r);
      }
    }
  }
  return [...rows.values()]
    .map(({ favWon, favAll, ...r }) => ({ ...r, favoriteShare: favAll ? Math.round((favWon / favAll) * 100) / 100 : 0 }))
    .sort((a, b) => a.character.localeCompare(b.character) || b.mostThemselves / (b.votes || 1) - a.mostThemselves / (a.votes || 1) || b.favoriteShare - a.favoriteShare);
}

export { closeScene, sceneMarkdown, transcript };
export type { Scene };
