// Scenes: characters playing a scene together, in text.
//
// A scene has a public card (setting, situation, stakes, stopping rule) and a private
// motivation for each character. The director (the showrunner) picks who speaks next and
// gives them a beat; each character answers from their own bible, the card, their own
// motivation and the transcript so far. Nobody sees anyone else's motivation. When the
// stopping rule is met or the turns run out, the scene closes, the motivations are revealed
// (unless the card says not to), and the transcript lands in the episode repo.
//
// Every line is a recorded agent run, so it is committed to the speaker's dressing room and
// its compute is on the ledger. Voice is not generated here: see voice.ts.

import type { Room, Scene } from "../core/room.ts";
import { RuleError } from "../core/room.ts";
import type { SceneTurn } from "../core/types.ts";
import { extractJson, type LLM } from "../agents/llm.ts";
import { nameOf, persona, record, showBible, systemFor } from "../agents/characters.ts";
import { modelFor } from "../core/cast.ts";
import { abilityNote, parseAction, performAction, can, type ServiceOptions } from "./abilities.ts";
import { EpisodeRepo } from "../repos/episode-repo.ts";
import { reposEnabled } from "../repos/dressing-room.ts";

export interface SceneContext {
  room: Room;
  llm: LLM;
  askedBy: string; // who started the scene: "leo", "patron:ada", ...
  /** Outside services characters can use (keys, and a fetch to fake them in tests). */
  services?: ServiceOptions;
}

export interface CastMember {
  character: string;
  motivation: string;
}

/** A character's name in this scene: a guest's name from the card, otherwise their own. */
export const nameIn = (s: Scene, slug: string) => s.guests?.[slug]?.name ?? nameOf(slug);
const speaker = (s: Scene, slug: string) => nameIn(s, slug).toUpperCase();
const isGuest = (s: Scene, slug: string) => !!s.guests?.[slug];

/** Who a character is, for the model: their bible, or a guest's persona from the card. */
function systemIn(s: Scene, who: string): string {
  const g = s.guests?.[who];
  return g ? [showBible(), "---", `# ${g.name}\n\n${g.persona}`].join("\n\n") : systemFor(who);
}

/** The model that plays `who` here: the scene's casting, then cast.json, then the room default. */
export const modelIn = (s: Scene, who: string) => s.models[who] ?? modelFor(who);
const directorModel = (s: Scene) => s.models.director ?? modelFor("showrunner");

export function transcript(s: Scene, upTo = s.turns.length): string {
  const out: string[] = [];
  const happened = (n: number) => s.happenings.filter((h) => h.afterTurn === n).map((h) => `[${h.kind === "bill" ? "BILL" : h.kind === "voice" ? "VOICE" : "MEANWHILE"}] ${h.text}`);
  out.push(...happened(0));
  for (const t of s.turns.slice(0, upTo)) {
    out.push(`${t.cue ? `${t.cue}\n` : ""}${speaker(s, t.character)}: ${t.line}`);
    out.push(...happened(t.n));
  }
  return out.join("\n");
}

/** What happened in the earlier scenes of this episode, for everyone to have in mind. */
function earlier(ctx: SceneContext, s: Scene, limit = 9000): string {
  if (!s.after?.length) return "";
  const parts = s.after.map((id) => {
    const p = ctx.room.mustScene(id);
    return `## Earlier: ${p.title}\n${transcript(p)}`;
  });
  let text = parts.join("\n\n");
  if (text.length > limit) text = `…${text.slice(-limit)}`;
  return `${text}\n\n---\n\n`;
}

function card(s: Scene): string {
  return [
    `SCENE: ${s.title}`,
    `Setting: ${s.setting}`,
    `Situation: ${s.situation}`,
    `What's at stake: ${s.stakes}`,
    `In the scene: ${s.cast.map((c) => nameIn(s, c)).join(", ")}`,
    `The scene ends when: ${s.stoppingRule}`,
  ].join("\n");
}

// ---------------------------------------------------------------- the director

export interface Direction {
  next: string; // character slug
  beat?: string;
  cue?: string;
  end?: boolean;
  reason?: string;
}

/** Without a model the director goes round the cast in order and ends at the turn limit. */
function fallbackDirection(s: Scene): Direction {
  if (s.turns.length >= s.maxTurns) return { next: "", end: true, reason: `all ${s.maxTurns} turns used` };
  return { next: s.cast[s.turns.length % s.cast.length] };
}

export async function direct(ctx: SceneContext, s: Scene): Promise<Direction> {
  if (s.turns.length >= s.maxTurns) return { next: "", end: true, reason: `all ${s.maxTurns} turns used` };
  // The director knows every motivation; that's how it shapes the scene. It never reveals them.
  // Its runs stay producer-only (no ideaId, which would make them public): its reasons can name what people want.
  const motivations = s.cast.map((c) => `- ${nameIn(s, c)} (${c}) privately wants: ${s.motivations[c]}`).join("\n");
  const c = await ctx.llm.complete({
    model: directorModel(s),
    system: `${showBible()}\n\n---\n\n${persona("showrunner")}\n\nRight now you are directing a scene, not assembling a cut.`,
    user: `${earlier(ctx, s)}${card(s)}

Private motivations (only you see all of them; never put them in a beat verbatim):
${motivations}

Transcript so far (${s.turns.length} of at most ${s.maxTurns} lines):
${transcript(s) || "(the scene hasn't started)"}

Decide the next line. Give the speaker a beat: one short direction about what this line should do, without telling them what to say. Add a music or sound cue only when the grammar calls for it (song is what they struggle to say; instrumental is what they have no words for yet). End the scene as soon as the stopping rule is met, not before.

Reply with only a JSON block:
\`\`\`json
{"next":"<character slug>","beat":"","cue":"","end":false,"reason":""}
\`\`\``,
    maxTokens: 300,
  });
  const d = extractJson<Direction>(c.text);
  const flags: string[] = [];
  let out: Direction;
  if (!d || (!d.end && !s.cast.includes(d.next))) {
    if (!c.offline) flags.push("director reply unusable; went round the cast");
    out = fallbackDirection(s);
  } else out = { next: d.next, beat: d.beat?.trim() || undefined, cue: d.cue?.trim() || undefined, end: !!d.end, reason: d.reason?.trim() || undefined };
  if (!c.offline || flags.length)
    record({ room: ctx.room, llm: ctx.llm, askedBy: ctx.askedBy, scope: "producer", commit: !s.trialId }, "showrunner", { episodeId: s.episodeId, question: `direct ${s.sceneId} line ${s.turns.length + 1}` }, out, out.end ? `End ${s.sceneId}: ${out.reason ?? "stopping rule met"}.` : `${nameIn(s, out.next)} next.`, c, [], flags);
  return out;
}

// ---------------------------------------------------------------- a line

export async function speak(ctx: SceneContext, s: Scene, who: string, d: Direction) {
  const c = await ctx.llm.complete({
    model: modelIn(s, who),
    system: systemIn(s, who),
    user: `${earlier(ctx, s)}${card(s)}

Your private motivation in this scene (no one else knows it; pursue it, don't announce it):
${s.motivations[who]}

${d.beat ? `The director's note for this line: ${d.beat}\n\n` : ""}Transcript so far:
${transcript(s) || "(you speak first)"}

Say ${nameIn(s, who)}'s next line. One to three spoken sentences, in your own voice. Only the words spoken: no name, no quotation marks, no stage directions.${abilityNote(ctx.room, s, who, nameIn)}`,
    maxTokens: 300,
  });
  const flags: string[] = [];
  const { text: said, action } = can(s, who, "design-voice") ? parseAction(c.text) : { text: c.text, action: null };
  let line = clean(said, who, nameIn(s, who));
  if (!line) {
    if (!c.offline) flags.push("no line returned; used a placeholder");
    line = d.beat ? `(offline — ${nameIn(s, who)}: ${d.beat})` : `(offline — ${nameIn(s, who)} takes line ${s.turns.length + 1})`;
  }
  // Blind tastings keep their runs (which name the model) producer-only until revealed.
  const blind = !!s.trialId;
  const run = record(
    { room: ctx.room, llm: ctx.llm, askedBy: `scene:${s.sceneId}`, scope: blind ? "producer" : "public", commit: !blind && !isGuest(s, who) },
    who,
    { ideaId: blind ? undefined : s.ideaId, episodeId: s.episodeId, question: `${s.sceneId} line ${s.turns.length + 1}` },
    { sceneId: s.sceneId, beat: d.beat ?? null },
    line,
    c,
    [],
    flags,
  );
  const turn: Omit<SceneTurn, "n"> = { sceneId: s.sceneId, character: who, line, beat: d.beat, cue: d.cue, runId: (run.payload as { runId: string }).runId };
  const ev = ctx.room.recordSceneTurn(ctx.askedBy, turn);
  if (action && abilityNote(ctx.room, s, who, nameIn)) await performAction(ctx.room, ctx.room.mustScene(s.sceneId), who, action, nameIn, ctx.services);
  return ev;
}

/** When something just landed on someone (a bill), the next line is theirs. */
function pendingAddressee(s: Scene): { who: string; text: string } | null {
  const h = s.happenings.filter((x) => x.afterTurn === s.turns.length && x.addressee).at(-1);
  return h ? { who: h.addressee!, text: h.text } : null;
}

/** Strip what models add around a spoken line: a name prefix, quotes, stage directions. */
export function clean(text: string, who: string, name = nameOf(who)): string {
  let t = (text ?? "").trim().split(/\n{2,}/)[0].trim();
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  t = t.replace(new RegExp(`^\\**(${esc(name)}|${esc(who)})\\**\\s*:\\s*`, "i"), "");
  t = t.replace(/^["“](.*)["”]$/s, "$1");
  t = t.replace(/\*[^*]+\*/g, "").replace(/\((?:[^)]*?\b(?:pauses?|sighs?|smiles?|laughs?|beat)\b[^)]*)\)/gi, "");
  return t.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- the whole scene

export function openScene(ctx: SceneContext, input: Parameters<Room["openScene"]>[1], cast: CastMember[]): Scene {
  const ev = ctx.room.openScene(ctx.askedBy, input, cast);
  return ctx.room.mustScene((ev.payload as { sceneId: string }).sceneId);
}

/** Play the scene to its end (or `maxSteps` more lines). Returns the scene. */
export async function runScene(ctx: SceneContext, sceneId: string, { maxSteps = Infinity }: { maxSteps?: number } = {}): Promise<Scene> {
  let steps = 0;
  for (;;) {
    const s = ctx.room.mustScene(sceneId);
    if (s.closed) return s;
    if (steps >= maxSteps) return s;
    const landed = s.turns.length < s.maxTurns ? pendingAddressee(s) : null;
    const d = landed ? { next: landed.who, beat: `This just landed in front of you: ${landed.text} React to it now.` } : await direct(ctx, s);
    if (d.end) {
      closeScene(ctx, s, d.reason ?? "the stopping rule was met");
      return ctx.room.mustScene(sceneId);
    }
    await speak(ctx, s, d.next, d);
    steps++;
  }
}

export function closeScene(ctx: SceneContext, s: Scene, reason: string) {
  let repo: { name: string; sha: string; file: string } | undefined;
  if (s.episodeId && reposEnabled() && !s.trialId) {
    const ep = new EpisodeRepo(s.episodeId);
    ep.ensure(ctx.room.mustEpisode(s.episodeId));
    const file = `scenes/${s.sceneId}.md`;
    ep.repo.write(file, sceneMarkdown(s, reason));
    repo = { name: ep.repo.name, sha: ep.repo.commit(`${s.sceneId}: ${s.title} (${s.turns.length} lines)`), file };
  }
  return ctx.room.closeScene(ctx.askedBy, s.sceneId, reason, repo);
}

export function sceneMarkdown(s: Scene, reason?: string): string {
  return [
    `# ${s.sceneId} — ${s.title}`,
    "",
    `| | |`,
    `|---|---|`,
    `| Setting | ${s.setting} |`,
    `| Situation | ${s.situation} |`,
    `| Stakes | ${s.stakes} |`,
    `| Ends when | ${s.stoppingRule} |`,
    `| Cast | ${s.cast.map((c) => nameIn(s, c)).join(", ")} |`,
    `| Lines | ${s.turns.length} of at most ${s.maxTurns} |`,
    ...(reason ? [`| Closed | ${reason} |`] : []),
    "",
    "## The scene",
    "",
    ...s.happenings.filter((h) => h.afterTurn === 0).flatMap((h) => [`> **${h.kind === "bill" ? "Bill" : h.kind === "voice" ? "Voice" : "Meanwhile"}.** ${h.text}`, ""]),
    ...s.turns.flatMap((t) => [
      ...(t.cue ? [`${t.cue}`, ""] : []),
      `**${speaker(s, t.character)}:** ${t.line}`,
      "",
      ...s.happenings.filter((h) => h.afterTurn === t.n).flatMap((h) => [`> **${h.kind === "bill" ? "Bill" : h.kind === "voice" ? "Voice" : "Meanwhile"}.** ${h.text}`, ""]),
    ]),
    ...(s.revealMotivations
      ? ["## What each of them wanted", "", ...s.cast.map((c) => `- **${nameIn(s, c)}:** ${s.motivations[c]}`), ""]
      : []),
    "_Improvised in the writers' room. Nothing here is canon until it is in a released episode._",
    "",
  ].join("\n");
}

/** The public view of a scene: motivations only once revealed. */
export function publicScene(s: Scene) {
  return {
    sceneId: s.sceneId,
    title: s.title,
    setting: s.setting,
    situation: s.situation,
    stakes: s.stakes,
    stoppingRule: s.stoppingRule,
    maxTurns: s.maxTurns,
    cast: s.cast.map((c) => ({ character: c, name: nameIn(s, c), guest: isGuest(s, c) })),
    guests: s.guests ?? null,
    after: s.after ?? [],
    trialId: s.trialId ?? null,
    abilities: s.abilities ?? null,
    happenings: s.happenings.map((h) => ({ afterTurn: h.afterTurn, kind: h.kind, text: h.text, addressee: h.addressee ?? null, ref: h.ref ?? null })),
    episodeId: s.episodeId,
    ideaId: s.ideaId,
    openedAt: s.openedAt,
    turns: s.turns.map((t) => ({ n: t.n, character: t.character, line: t.line, cue: t.cue, voiced: !!s.voiced[t.n] })),
    closed: s.closed ? { at: s.closed.at, reason: s.closed.reason, repo: s.closed.repo } : null,
    motivations: s.closed?.motivations ?? null,
  };
}

export function sceneOrThrow(room: Room, id: string): Scene {
  const s = room.scenes.get(id);
  if (!s) throw new RuleError("scene", `No scene ${id}.`);
  return s;
}
