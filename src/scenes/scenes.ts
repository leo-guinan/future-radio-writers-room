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
import { EpisodeRepo } from "../repos/episode-repo.ts";
import { reposEnabled } from "../repos/dressing-room.ts";

export interface SceneContext {
  room: Room;
  llm: LLM;
  askedBy: string; // who started the scene: "leo", "patron:ada", ...
}

export interface CastMember {
  character: string;
  motivation: string;
}

const speaker = (slug: string) => nameOf(slug).toUpperCase();

export function transcript(s: Scene, upTo = s.turns.length): string {
  return s.turns
    .slice(0, upTo)
    .map((t) => `${t.cue ? `${t.cue}\n` : ""}${speaker(t.character)}: ${t.line}`)
    .join("\n");
}

function card(s: Scene): string {
  return [
    `SCENE ${s.sceneId}: ${s.title}`,
    `Setting: ${s.setting}`,
    `Situation: ${s.situation}`,
    `What's at stake: ${s.stakes}`,
    `In the scene: ${s.cast.map(nameOf).join(", ")}`,
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
  const motivations = s.cast.map((c) => `- ${nameOf(c)} (${c}) privately wants: ${s.motivations[c]}`).join("\n");
  const c = await ctx.llm.complete({
    system: `${showBible()}\n\n---\n\n${persona("showrunner")}\n\nRight now you are directing a scene, not assembling a cut.`,
    user: `${card(s)}

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
    record({ room: ctx.room, llm: ctx.llm, askedBy: ctx.askedBy, scope: "producer" }, "showrunner", { episodeId: s.episodeId, question: `direct ${s.sceneId} line ${s.turns.length + 1}` }, out, out.end ? `End ${s.sceneId}: ${out.reason ?? "stopping rule met"}.` : `${nameOf(out.next)} next.`, c, [], flags);
  return out;
}

// ---------------------------------------------------------------- a line

export async function speak(ctx: SceneContext, s: Scene, who: string, d: Direction) {
  const c = await ctx.llm.complete({
    system: systemFor(who),
    user: `${card(s)}

Your private motivation in this scene (no one else knows it; pursue it, don't announce it):
${s.motivations[who]}

${d.beat ? `The director's note for this line: ${d.beat}\n\n` : ""}Transcript so far:
${transcript(s) || "(you speak first)"}

Say ${nameOf(who)}'s next line. One to three spoken sentences, in your own voice. Only the words spoken: no name, no quotation marks, no stage directions.`,
    maxTokens: 220,
  });
  const flags: string[] = [];
  let line = clean(c.text, who);
  if (!line) {
    if (!c.offline) flags.push("no line returned; used a placeholder");
    line = d.beat ? `(offline — ${nameOf(who)}: ${d.beat})` : `(offline — ${nameOf(who)} takes line ${s.turns.length + 1})`;
  }
  const run = record(
    { room: ctx.room, llm: ctx.llm, askedBy: `scene:${s.sceneId}`, scope: "public" },
    who,
    { ideaId: s.ideaId, episodeId: s.episodeId, question: `${s.sceneId} line ${s.turns.length + 1}` },
    { sceneId: s.sceneId, beat: d.beat ?? null },
    line,
    c,
    [],
    flags,
  );
  const turn: Omit<SceneTurn, "n"> = { sceneId: s.sceneId, character: who, line, beat: d.beat, cue: d.cue, runId: (run.payload as { runId: string }).runId };
  return ctx.room.recordSceneTurn(ctx.askedBy, turn);
}

/** Strip what models add around a spoken line: a name prefix, quotes, stage directions. */
export function clean(text: string, who: string): string {
  let t = (text ?? "").trim().split(/\n{2,}/)[0].trim();
  const name = nameOf(who);
  t = t.replace(new RegExp(`^\\**(${name}|${who})\\**\\s*:\\s*`, "i"), "");
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
    const d = await direct(ctx, s);
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
  if (s.episodeId && reposEnabled()) {
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
    `| Cast | ${s.cast.map(nameOf).join(", ")} |`,
    `| Lines | ${s.turns.length} of at most ${s.maxTurns} |`,
    ...(reason ? [`| Closed | ${reason} |`] : []),
    "",
    "## The scene",
    "",
    ...s.turns.flatMap((t) => [...(t.cue ? [`${t.cue}`, ""] : []), `**${speaker(t.character)}:** ${t.line}`, ""]),
    ...(s.revealMotivations
      ? ["## What each of them wanted", "", ...s.cast.map((c) => `- **${nameOf(c)}:** ${s.motivations[c]}`), ""]
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
    cast: s.cast.map((c) => ({ character: c, name: nameOf(c) })),
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
