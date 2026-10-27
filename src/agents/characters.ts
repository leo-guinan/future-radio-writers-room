// Borges remembers. Leonardo creates. Agnolo keeps the score.
// Each character reads its persona from characters/*.md, does one job, and every run
// is written to the event log with its usage and cost.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Room } from "../core/room.ts";
import type { AgentRun, Character, RoomEvent } from "../core/types.ts";
import { extractJson, type LLM } from "./llm.ts";
import { dressingRoom, reposEnabled } from "../repos/dressing-room.ts";

const CHAR_DIR = process.env.CHARACTERS_DIR ?? join(process.cwd(), "characters");
const template = (name: string) => readFileSync(join(CHAR_DIR, `${name}.md`), "utf8");
/** A character's persona comes from their dressing room once it exists; characters/ holds the templates. */
export const persona = (c: Character) => (reposEnabled() ? dressingRoom(c).persona() : template(c));
export const showBible = () => template("show-bible");
export const systemFor = (c: Character) => `${showBible()}\n\n---\n\n${persona(c)}`;

export const DEFAULT_CEILING = Number(process.env.DEFAULT_CASH_CEILING ?? 20);

export interface AskContext {
  room: Room;
  llm: LLM;
  askedBy: string;
  scope: "public" | "producer"; // what Borges may read
}

let runCounter = 0;
export const runId = (c: Character) => `R-${c[0].toUpperCase()}${Date.now().toString(36)}${(runCounter++).toString(36)}`;

// ---------------------------------------------------------------- Borges

export interface Passage {
  id: string;
  text: string;
  score: number;
}

/** Render an event as one line of archive text. */
export function describe(e: RoomEvent): string {
  const p = e.payload as any;
  const head = `${e.id} ${e.ts.slice(0, 10)} ${e.type} by ${e.actor}:`;
  switch (e.type) {
    case "idea.proposed":
      return `${head} idea ${p.ideaId} "${p.title}" (${p.output}). Question: ${p.question} Source: ${p.source}`;
    case "idea.transitioned":
      return `${head} ${p.ideaId} ${p.from} → ${p.to}. Reason: ${p.reason}${p.mergedInto ? ` Merged into ${p.mergedInto}.` : ""}${p.result ? ` Result: ${p.result}` : ""}`;
    case "idea.note":
      return `${head} note on ${p.ideaId}: ${p.text}`;
    case "agent.run":
      return `${head} ${p.character} on ${p.ideaId ?? p.episodeId ?? "the room"}: ${String(p.text).slice(0, 400)}`;
    case "episode.planned":
      return `${head} episode ${p.episodeId} "${p.title}": ${p.logline} Ceiling $${p.budget.cashCeiling}.`;
    case "episode.scene_added":
      return `${head} scene ${p.sceneId} "${p.title}" (${p.role}): ${p.summary} Question: ${p.question}`;
    case "episode.scene_selected":
      return `${head} scene ${p.sceneId} ${p.selected ? "selected" : "cut"}. Reason: ${p.reason}`;
    case "episode.released":
      return `${head} ${p.episodeId} ${p.version} released and locked (sha256 ${p.sha256.slice(0, 12)}). Invitation: ${p.invitation}`;
    case "forecast.recorded":
      return `${head} forecast ${p.forecastId}${p.verbatim ? " (verbatim)" : ""}: ${p.claim} Due ${p.dueBy}.`;
    case "forecast.resolved":
      return `${head} forecast ${p.forecastId} ${p.outcome}: ${p.observation}`;
    case "ledger.entry":
      return `${head} ${p.ledger} ${p.kind} ${p.amount} ${p.unit} (${p.status}): ${p.label}`;
    case "budget.authorized":
      return `${head} ${p.episodeId} ceiling raised to $${p.newCeiling}: ${p.reason}`;
    case "episode.stage":
      return `${head} ${p.episodeId} entered ${p.stage}${p.note ? `: ${p.note}` : ""}`;
    case "conference.held":
      return `${head} ${p.kind} press conference "${p.title}": ${p.notes}`;
    case "room.rules_locked":
      return `${head} rules locked: ${(p.rules as string[]).join(" ")}`;
    default:
      return `${head} ${JSON.stringify(p).slice(0, 300)}`;
  }
}

const STOP = new Set("the and for with that this what has have had was were are about before after from into onto than then them they their there which who whom why how when where will would could should can did does doing room talked talk tell know any some been being just also very more most much episode idea ideas".split(" "));
const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9$]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) ?? [];

/** Small BM25-style retrieval over the archive. No embeddings, no external service. */
export function search(room: Room, query: string, scope: "public" | "producer", k = 8): Passage[] {
  // Borges reads the record of what happened, not his own (or anyone's) earlier commentary.
  const events = room.store
    .all()
    .filter((e) => scope === "producer" || e.visibility === "public")
    .filter((e) => e.type !== "agent.run" && (e.type !== "ledger.entry" || scope === "producer"));
  const docs = events.map((e) => ({ id: e.id, text: describe(e), toks: tokenize(describe(e)) }));
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const N = docs.length;
  const avg = docs.reduce((s, d) => s + d.toks.length, 0) / N;
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.toks.includes(t)).length]));
  const scored = docs.map((d) => {
    let score = 0;
    for (const t of q) {
      const tf = d.toks.filter((x) => x === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.toks.length / avg)));
    }
    return { id: d.id, text: d.text, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

export async function borges(ctx: AskContext, question: string, ref: { ideaId?: string; episodeId?: string } = {}) {
  const passages = search(ctx.room, question, ctx.scope);
  const allowed = new Set(passages.map((p) => p.id));
  let text: string;
  let citations: string[] = [];
  const flags: string[] = [];
  const records = passages.map((p) => p.text).join("\n");
  const c = await ctx.llm.complete({
    system: systemFor("borges"),
    user: `Question from ${ctx.askedBy}: ${question}\n\nRecords you may use (and only these):\n${records || "(none)"}\n\nAnswer in Borges' voice, citing record ids in [brackets].`,
    maxTokens: 700,
  });
  if (c.offline || !c.text) {
    text = passages.length
      ? `The library offers ${passages.length} volume${passages.length > 1 ? "s" : ""} on this. The nearest: ${passages
          .slice(0, 3)
          .map((p) => `${p.text.replace(/^\S+ \S+ \S+ by \S+: /, "")} [${p.id}]`)
          .join(" · ")}`
      : "The library has no volume on that yet. Perhaps it is waiting for you to write it.";
    citations = passages.slice(0, 3).map((p) => p.id);
  } else {
    text = c.text.trim();
    citations = [...new Set(text.match(/ev_\d{6}/g) ?? [])];
    for (const id of citations) if (!allowed.has(id)) flags.push(`cited ${id}, which was not in the retrieved records`);
    if (!citations.length && passages.length) flags.push("no citations given");
  }
  const run = record(ctx, "borges", { question, ...ref }, { passages: passages.map((p) => p.id) }, text, c, citations, flags);
  return { run, passages, text };
}

// ---------------------------------------------------------------- Leonardo

export interface Approach {
  title: string;
  deliverable: string;
  runtimeMinutes: number;
  stoppingRule: string;
  estCashUsd: number;
  estHours: number;
  reuses: string[];
  risk: string;
}

export async function leonardo(ctx: AskContext, ideaId: string, memory?: string) {
  const idea = ctx.room.mustIdea(ideaId);
  const c = await ctx.llm.complete({
    system: systemFor("leonardo"),
    user: `Idea ${idea.ideaId} from ${idea.contributor.credit ? idea.contributor.name : "a patron"}: "${idea.title}"
Creative question: ${idea.question}
Proposed output: ${idea.output}
Source: ${idea.source}
${memory ? `Borges remembers: ${memory}\n` : ""}
Reply with two or three sentences in Leonardo's voice, then a JSON block:
\`\`\`json
{"approaches":[{"title":"","deliverable":"","runtimeMinutes":0,"stoppingRule":"","estCashUsd":0,"estHours":0,"reuses":[],"risk":""}],"favorite":0}
\`\`\``,
    maxTokens: 1400,
  });
  let parsed = extractJson<{ approaches: Approach[]; favorite?: number }>(c.text);
  const flags: string[] = [];
  let voice = c.text.split("```")[0].trim();
  if (!parsed?.approaches?.length) {
    if (!c.offline) flags.push("no structured approaches returned; used fallback sketches");
    parsed = { approaches: fallbackApproaches(idea.title, idea.output), favorite: 0 };
    voice ||= `Three sketches for "${idea.title}". I will want to keep improving all of them, so each one has a place where I must stop.`;
  }
  parsed.approaches = parsed.approaches.slice(0, 3);
  parsed.approaches.forEach((a, i) => {
    if (!a.stoppingRule?.trim()) flags.push(`approach ${i + 1} has no stopping rule`);
    if (!(a.estCashUsd >= 0)) flags.push(`approach ${i + 1} has no cash estimate`);
  });
  const run = record(ctx, "leonardo", { ideaId, episodeId: idea.episodeId }, parsed, voice, c, [], flags);
  return { run, approaches: parsed.approaches, favorite: parsed.favorite ?? 0, text: voice };
}

function fallbackApproaches(title: string, output: string): Approach[] {
  return [
    {
      title: `${title} — the spare version`,
      deliverable: `A 2–3 minute audio ${output} using two existing voices and one music cue`,
      runtimeMinutes: 3,
      stoppingRule: "Done after one listen-through with no blocking defects",
      estCashUsd: 4,
      estHours: 1.5,
      reuses: ["established character voices", "Not Enough Time motif"],
      risk: "May feel thin without sound design",
    },
    {
      title: `${title} — as a press-conference exhibit`,
      deliverable: "Agnolo puts the idea on his screen and summons it as a witness (4–5 min)",
      runtimeMinutes: 5,
      stoppingRule: "Done when the witness answers the creative question once",
      estCashUsd: 8,
      estHours: 3,
      reuses: ["Milliways ambience", "Agnolo and Yuria voices"],
      risk: "Leans on the frame; must still advance the story",
    },
    {
      title: `${title} — the song`,
      deliverable: "A short sung passage for what the characters struggle to say (1–2 min)",
      runtimeMinutes: 2,
      stoppingRule: "Done at the first take that carries the lyric clearly",
      estCashUsd: 10,
      estHours: 3,
      reuses: ["Unspoken Orchestra grammar"],
      risk: "Music generation cost and quality vary most",
    },
  ];
}

// ---------------------------------------------------------------- Agnolo

export interface Evaluation {
  scores: { story: number; business: number; participation: number };
  why: { story: string; business: string; participation: string };
  claims: Array<{ text: string; status: "observed" | "projected" | "disputed" | "unknown" }>;
  evidence: string; // what would count as evidence, and the cheapest test
  recommend: "compare" | "select" | "defer" | "decline";
  reason: string;
}

export async function agnolo(ctx: AskContext, ideaId: string, approaches: Approach[]) {
  const idea = ctx.room.mustIdea(ideaId);
  const ep = idea.episodeId ? ctx.room.episodes.get(idea.episodeId) : undefined;
  const ceiling = ep?.ceiling ?? DEFAULT_CEILING;
  const spent = ep ? ctx.room.episodeCash(ep.episodeId) : 0;
  const remaining = Math.max(0, ceiling - spent);
  // Arithmetic is done here, not by the model.
  const budget = approaches.map((a, i) => ({
    approach: i + 1,
    estCashUsd: a.estCashUsd,
    fits: a.estCashUsd <= remaining,
  }));
  const s = idea.signals;
  const c = await ctx.llm.complete({
    system: systemFor("agnolo"),
    user: `On the screen: idea ${idea.ideaId} "${idea.title}" (${idea.output}), proposed by ${idea.contributor.credit ? idea.contributor.name : "a patron"}.
Question: ${idea.question}
Leonardo's approaches: ${JSON.stringify(approaches)}
Budget (computed by the room): ceiling $${ceiling.toFixed(2)}, observed spend $${spent.toFixed(2)}, remaining $${remaining.toFixed(2)}. Fit by approach: ${JSON.stringify(budget)}
Signals, kept separate: creative judgments ${JSON.stringify(s.creative)}, community votes ${s.community}, financial support received $${s.financial}.

Reply with two or three sentences in Agnolo's voice, then a JSON block:
\`\`\`json
{"scores":{"story":0,"business":0,"participation":0},"why":{"story":"","business":"","participation":""},"claims":[{"text":"","status":"projected"}],"evidence":"","recommend":"compare","reason":""}
\`\`\``,
    maxTokens: 1200,
  });
  let ev = extractJson<Evaluation>(c.text);
  const flags: string[] = [];
  let voice = c.text.split("```")[0].trim();
  if (!ev?.scores) {
    if (!c.offline) flags.push("no structured evaluation returned; used rule-based scoring");
    ev = fallbackEvaluation(idea.output, approaches);
    voice ||= `Exhibit ${idea.ideaId} is on the screen. Every number Leonardo gave me is a forecast, and I have booked it as one.`;
  }
  for (const k of ["story", "business", "participation"] as const) ev.scores[k] = Math.max(0, Math.min(3, Math.round(Number(ev.scores[k]) || 0)));
  // The rules overrule the recommendation when the money doesn't fit.
  if (ev.recommend === "select" && !budget.some((b) => b.fits)) {
    ev.recommend = "compare";
    ev.reason = `No approach fits the remaining $${remaining.toFixed(2)}. Simplify, or authorize a larger budget first. (${ev.reason})`;
    flags.push("select overruled: over budget");
  }
  const run = record(ctx, "agnolo", { ideaId, episodeId: idea.episodeId }, { ...ev, budget: { ceiling, spent, remaining, byApproach: budget } }, voice, c, [], flags);
  return { run, evaluation: ev, budget: { ceiling, spent, remaining, byApproach: budget }, text: voice };
}

function fallbackEvaluation(output: string, approaches: Approach[]): Evaluation {
  const story = ["scene", "episode", "song"].includes(output) ? 2 : 1;
  const business = output === "capability" ? 2 : 1;
  const participation = 2;
  return {
    scores: { story, business, participation },
    why: {
      story: "Scored by output type until a person or a model judges it.",
      business: "Scored by output type until a person or a model judges it.",
      participation: "It arrived through the room, which is itself participation.",
    },
    claims: approaches.map((a) => ({ text: `${a.title} costs about $${a.estCashUsd} and ${a.estHours}h`, status: "projected" as const })),
    evidence: "Produce the cheapest approach and record actual cash and hours against its estimate.",
    recommend: "compare",
    reason: "Offline scoring is a placeholder; compare against other candidates this round.",
  };
}

// ---------------------------------------------------------------- the room at work

/** Borges → Leonardo → Agnolo on one idea, then mark it explored. */
export async function explore(ctx: AskContext, ideaId: string) {
  const idea = ctx.room.mustIdea(ideaId);
  const memory = await borges(ctx, `${idea.title} ${idea.question} ${idea.source}`, { ideaId, episodeId: idea.episodeId });
  const created = await leonardo(ctx, ideaId, memory.text);
  const judged = await agnolo(ctx, ideaId, created.approaches);
  if (idea.status === "proposed") {
    ctx.room.transitionIdea("system", {
      ideaId,
      to: "explored",
      reason: `Explored by the room: Borges ${memory.run.id}, Leonardo ${created.run.id}, Agnolo ${judged.run.id}. Agnolo recommends '${judged.evaluation.recommend}'.`,
    });
  }
  return { memory, created, judged };
}

export async function ask(ctx: AskContext, character: Character, question: string, ideaId?: string) {
  if (character === "borges") return borges(ctx, question, { ideaId });
  if (!ideaId) throw new Error(`${character} needs an idea to work on.`);
  if (character === "leonardo") return leonardo(ctx, ideaId, question);
  const prior = [...ctx.room.runs.values()].filter((r) => r.ideaId === ideaId && r.character === "leonardo").at(-1);
  const approaches = ((prior?.output as any)?.approaches as Approach[]) ?? fallbackApproaches(ctx.room.mustIdea(ideaId).title, ctx.room.mustIdea(ideaId).output);
  return agnolo(ctx, ideaId, approaches);
}

export function record(
  ctx: AskContext,
  character: Character,
  ref: { ideaId?: string; episodeId?: string; question?: string },
  output: unknown,
  text: string,
  c: { usage: { input: number; output: number }; costUsd: number | null; model: string; offline: boolean },
  citations: string[],
  flags: string[],
): RoomEvent<AgentRun> {
  const run: AgentRun = {
    runId: runId(character),
    character,
    ideaId: ref.ideaId,
    episodeId: ref.episodeId,
    askedBy: ctx.askedBy,
    prompt: ref.question ?? "",
    output,
    text,
    citations,
    flags,
    model: c.model,
    usage: c.usage,
    costUsd: c.costUsd,
    offline: c.offline,
  };
  const ev = ctx.room.recordRun(run, ctx.scope === "producer" && !ref.ideaId ? "producer" : "public") as RoomEvent<AgentRun>;
  if (reposEnabled()) {
    // Every run is also a commit in the character's dressing room.
    const { sha, file } = dressingRoom(character).recordRun(run, ev.ts, ev.id, ev.hash);
    ctx.room.store.append(
      "repo.commit",
      character,
      { repo: dressingRoom(character).repo.name, sha, message: `${run.runId}`, files: [file], runId: run.runId, ideaId: run.ideaId, episodeId: run.episodeId },
      ev.visibility,
    );
  }
  return ev;
}
