// The showrunner. Starts each episode with an empty repo and the show plan, and on every
// tick pulls together whatever the room has decided is good enough into first cuts.
//
//   1. Make sure the episode repo exists (show plan + gates only, the first time).
//   2. Gather the episode's open candidates. Get unexplored ones explored (bounded).
//   3. Switch gates on according to load. Check every candidate against them.
//   4. For the best ready candidates (within capacity): project the cast from their
//      dressing rooms, assemble a first cut, commit it, and mark the idea 'compared'.
//   5. Write GATES.md explaining what passed, what was held and why. Commit. Record the tick.

import type { Idea, Room } from "../core/room.ts";
import type { GateResult, IdeaCut, ShowrunnerTick } from "../core/types.ts";
import { explore, latestRun, nameOf, record, showBible, persona, type Approach, type Evaluation, DEFAULT_CEILING } from "../agents/characters.ts";
import type { LLM } from "../agents/llm.ts";
import { EpisodeRepo, type Projection } from "../repos/episode-repo.ts";
import { extrasRepo } from "../repos/extras.ts";
import { activeGates, evaluate, type Candidate, type GatesFile } from "./gates.ts";
import { castFile, playedBy, roleCharacters, type Role } from "../core/cast.ts";

const OPEN = new Set(["proposed", "explored", "compared", "selected"]);
const MIN_CUT_BUDGET = Number(process.env.SHOWRUNNER_MIN_BUDGET ?? 0.5);
const DAILY_EXPLORES = Number(process.env.SHOWRUNNER_DAILY_EXPLORES ?? 30);

function exploresToday(room: Room) {
  const day = new Date().toISOString().slice(0, 10);
  return [...room.runs.values()].filter((r) => r.askedBy === "showrunner" && (r.role ? r.role === "making" : r.character === playedBy("making")) && r.at.startsWith(day)).length;
}

export interface TickOptions {
  includeUnassigned?: boolean; // let unassigned ideas be cut for this episode
  explore?: boolean; // run the room on unexplored ideas (costs model calls)
}

export function candidatesFor(room: Room, episodeId: string, includeUnassigned = true): Idea[] {
  const cut = new Set(room.cuts.filter((c) => c.episodeId === episodeId).map((c) => c.ideaId));
  return [...room.ideas.values()].filter(
    (i) => OPEN.has(i.status) && !cut.has(i.ideaId) && (i.episodeId === episodeId || (includeUnassigned && !i.episodeId)),
  );
}

function latest<T>(room: Room, ideaId: string, role: Role): T | null {
  return (latestRun(room, ideaId, role)?.output as T) ?? null;
}

export function describeCandidate(room: Room, idea: Idea, remaining: number): Candidate {
  const leo = latest<{ approaches: Approach[]; favorite?: number }>(room, idea.ideaId, "making");
  const evaluation = latest<Evaluation>(room, idea.ideaId, "accounting");
  const approaches = leo?.approaches ?? null;
  let chosen: Approach | null = null;
  if (approaches?.length) {
    const fitting = approaches.filter((a) => a.stoppingRule?.trim() && a.estCashUsd <= remaining).sort((a, b) => a.estCashUsd - b.estCashUsd);
    chosen = fitting[0] ?? approaches[leo?.favorite ?? 0] ?? approaches[0];
  }
  const total = evaluation?.scores ? evaluation.scores.story + evaluation.scores.business + evaluation.scores.participation : null;
  return { idea, approaches, evaluation, chosen, remaining, total };
}

export async function tick(room: Room, llm: LLM, episodeId: string, opts: TickOptions = {}): Promise<ShowrunnerTick> {
  const ep = room.mustEpisode(episodeId);
  const repo = new EpisodeRepo(episodeId);
  if (ep.releases.length) throw new Error(`${episodeId} is released and locked; the showrunner doesn't touch it.`);
  const created = repo.ensure(ep);
  if (created.created)
    room.store.append("repo.commit", "showrunner", { repo: repo.repo.name, sha: created.sha, message: "Show plan", files: ["SHOW_PLAN.md", "gates.json"], episodeId });
  const gatesFile = repo.gates() as GatesFile;
  const cap = gatesFile.capacity;
  const ctx = { room, llm, askedBy: "showrunner", scope: "producer" as const };

  // 2. Explore what hasn't been explored yet.
  const explored: string[] = [];
  if (opts.explore !== false) {
    for (const idea of candidatesFor(room, episodeId, opts.includeUnassigned !== false)) {
      if (explored.length >= cap.maxExploresPerTick || exploresToday(room) >= DAILY_EXPLORES) break;
      const hasRuns = latest(room, idea.ideaId, "making") && latest(room, idea.ideaId, "accounting");
      if (!hasRuns) {
        await explore(ctx, idea.ideaId);
        explored.push(idea.ideaId);
      }
    }
  }

  // 3. Gates by load.
  const open = candidatesFor(room, episodeId, opts.includeUnassigned !== false);
  const load = open.length;
  const gates = activeGates(gatesFile, load);
  const remaining = () => Math.max(0, ep.ceiling - room.episodeCash(episodeId));
  const cutTexts = room.cuts
    .filter((c) => c.episodeId === episodeId)
    .map((c) => ({ ideaId: c.ideaId, text: `${room.mustIdea(c.ideaId).title} ${room.mustIdea(c.ideaId).question}` }));
  const results = open.map((idea) => {
    const c = describeCandidate(room, idea, remaining());
    return { c, results: evaluate(c, gates, { room, cutTexts }) };
  });
  const ready = results
    .filter((r) => r.results.every((g) => g.pass))
    .sort((a, b) => (b.c.total ?? 0) - (a.c.total ?? 0) || b.c.idea.signals.community - a.c.idea.signals.community || a.c.idea.proposedAt.localeCompare(b.c.idea.proposedAt));
  const held = results.filter((r) => !r.results.every((g) => g.pass));

  // 4. Cut within capacity.
  const already = room.cuts.filter((c) => c.episodeId === episodeId).length;
  const room4 = Math.max(0, Math.min(cap.maxCutsPerTick, cap.maxCutsPerEpisode - already));
  const toCut = ready.slice(0, room4);
  const queued = ready.slice(room4).map((r) => r.c.idea.ideaId);
  const cut: string[] = [];
  for (const r of toCut) {
    await assembleCut(room, llm, repo, episodeId, r.c, r.results, gates.map((g) => g.gate));
    cut.push(r.c.idea.ideaId);
  }

  // 5. Report.
  repo.repo.write("GATES.md", report(episodeId, load, gates.map((g) => `${g.gate} (≥${g.activateAt})`), results, cut, queued, explored));
  const sha = repo.repo.commit(`Showrunner tick: load ${load}, ${cut.length} cut, ${held.length} held, ${queued.length} queued`);
  const summary: ShowrunnerTick = {
    episodeId,
    load,
    activeGates: gates.map((g) => g.gate),
    explored,
    cut,
    held: held.map((h) => ({ ideaId: h.c.idea.ideaId, failed: h.results.filter((g) => !g.pass) })),
    queued,
    repoSha: sha,
  };
  room.store.append("showrunner.tick", "showrunner", summary, "public");
  return summary;
}

async function assembleCut(room: Room, llm: LLM, repo: EpisodeRepo, episodeId: string, c: Candidate, passed: GateResult[], activeGateNames: string[]) {
  const idea = c.idea;
  const a = c.chosen!;
  const query = `${idea.title} ${idea.question} ${idea.source}`;
  // The characters who play the room's roles, plus any extra the idea mentions by name.
  const mentioned = extrasRepo().repo.exists ? extrasRepo().mentionedIn(`${idea.title} ${idea.question} ${idea.source} ${a.title} ${a.deliverable}`) : [];
  const projections: Projection[] = [...roleCharacters(), ...mentioned.filter((m) => !roleCharacters().includes(m))].map((ch) => repo.project(ch, query, idea.ideaId));
  const cast = projections.map((p) => repo.repo.read(p.file)).join("\n\n---\n\n");
  const ep = room.mustEpisode(episodeId);

  let beats = "";
  let script = "";
  let usedModel = false;
  const canSpend = c.remaining - a.estCashUsd >= MIN_CUT_BUDGET || llm.offline;
  if (!llm.offline && canSpend) {
    const res = await llm.complete({
      system: `${showBible()}\n\n---\n\n${persona("showrunner")}`,
      user: `Episode ${episodeId} "${ep.title}": ${ep.logline}
Runtime target for this cut: ${a.runtimeMinutes} minutes. Stopping rule: ${a.stoppingRule}

Idea ${idea.ideaId} "${idea.title}" — ${idea.question}
Source: ${idea.source}
Chosen approach: ${JSON.stringify(a)}
${nameOf(playedBy("accounting"))}'s evaluation: ${JSON.stringify(c.evaluation)}

The cast, projected from their dressing rooms (use only this material; cite dressing-room paths for borrowed lines):
${cast}

Write the first cut. Reply with exactly two sections:
=== BEATS ===
(numbered beats, each with who, what we hear, and approximate seconds)
=== SCRIPT ===
(audio script: SPEAKER: line, with [MUSIC] and [SFX] cues)`,
      maxTokens: 2500,
    });
    const m = res.text.match(/=== BEATS ===([\s\S]*?)=== SCRIPT ===([\s\S]*)/);
    if (m) {
      beats = m[1].trim();
      script = m[2].trim();
      usedModel = true;
    }
    record({ room, llm, askedBy: "showrunner", scope: "producer" }, "showrunner", { ideaId: idea.ideaId, episodeId, question: `first cut of ${idea.ideaId}` }, { beats: !!beats, script: !!script }, usedModel ? `First cut of ${idea.ideaId} assembled.` : `Model reply for ${idea.ideaId} had no BEATS/SCRIPT sections; used the template.`, res, [], usedModel ? [] : ["template fallback"]);
  }
  if (!usedModel) ({ beats, script } = templateCut(room, idea, a, c, projections));

  const card = cardFor(idea, a, c, passed, activeGateNames, projections, usedModel);
  const files = repo.writeCut(idea.ideaId, { "CARD.md": card, "BEATS.md": `# Beats — ${idea.title}\n\n${beats}\n`, "SCRIPT.md": `# Script — ${idea.title}\n\n_First cut, ${a.runtimeMinutes} min target. ${a.stoppingRule}._\n\n${script}\n` });
  const sha = repo.repo.commit(`First cut: ${idea.ideaId} — ${idea.title}`);
  room.store.append("repo.commit", "showrunner", { repo: repo.repo.name, sha, message: `First cut: ${idea.ideaId}`, files: [...files, ...projections.map((p) => p.file)], ideaId: idea.ideaId, episodeId });
  const cutEvent: IdeaCut = {
    ideaId: idea.ideaId,
    episodeId,
    repo: repo.repo.name,
    sha,
    path: `cuts/${idea.ideaId}`,
    approach: a.title,
    gatesPassed: passed.map((g) => g.gate),
    projections: projections.map((p) => ({ character: p.character, repo: p.repo, sha: p.sha })),
  };
  room.store.append("idea.cut", "showrunner", cutEvent, "public");
  if (idea.status === "explored" || idea.status === "proposed")
    room.transitionIdea("showrunner", { ideaId: idea.ideaId, to: "compared", reason: `First cut assembled in ${repo.repo.name}@${sha.slice(0, 7)} (${a.title}). Ready for comparison; the producer selects.` });
}

function templateCut(room: Room, idea: Idea, a: Approach, c: Candidate, projections: Projection[]) {
  const cast = castFile();
  const mem = cast.roles.memory, mak = cast.roles.making, acc = cast.roles.accounting;
  const upper = (slug: string) => nameOf(slug).toUpperCase();
  const HOST = cast.host ? upper(cast.host) : "HOST";
  const memProj = projections.find((p) => p.character === mem)!;
  const said = (role: Role) => latestRun(room, idea.ideaId, role);
  const s = c.evaluation?.scores;
  const secs = Math.round(a.runtimeMinutes * 60);
  const beats = [
    `1. **Cold open** — ${HOST} introduces the transmission. (~${Math.round(secs * 0.1)}s)`,
    `2. **${nameOf(mem)} remembers** — what the archive already holds on "${idea.title}". (~${Math.round(secs * 0.2)}s) _source: \`${memProj.repo}@${memProj.sha.slice(0, 7)}\`_`,
    `3. **${nameOf(mak)} makes it** — ${a.deliverable}. (~${Math.round(secs * 0.45)}s)`,
    `4. **${nameOf(acc)} accounts** — story ${s?.story ?? "?"}/3, business ${s?.business ?? "?"}/3, participation ${s?.participation ?? "?"}/3; ~$${a.estCashUsd} projected, not booked. (~${Math.round(secs * 0.15)}s)`,
    `5. **The invitation** — ${HOST} asks listeners to answer: "${idea.question}" (~${Math.round(secs * 0.1)}s)`,
  ].join("\n");
  const clip = (t?: string) => {
    const line = (t ?? "").split(/\n/)[0];
    return line.length <= 280 ? line : line.slice(0, 280).replace(/\s+\S*$/, "") + "…";
  };
  const script = [
    `[MUSIC] ${cast.show} ident.`,
    `${HOST}: This is ${cast.show}. Tonight, a transmission the audience asked for: ${idea.title}.`,
    ``,
    `${upper(mem)}: ${clip(said("memory")?.text) || "The archive has nothing on this yet."}`,
    ``,
    `[MUSIC] Under ${nameOf(mak)}.`,
    `${upper(mak)}: ${clip(said("making")?.text) || `Let me sketch it: ${a.deliverable}.`}`,
    `${upper(mak)}: (aside) And I stop when — ${a.stoppingRule.toLowerCase()}.`,
    ``,
    `${upper(acc)}: ${clip(said("accounting")?.text) || "Every number here is a forecast, and I've booked it as one."}`,
    ``,
    `${HOST}: ${idea.question} Tell us. The writers' room is open.`,
    `[MUSIC] Out.`,
  ].join("\n");
  return { beats: `${beats}\n\n_Template cut (offline). Lines reuse what each character already said in the room._`, script };
}

function cardFor(idea: Idea, a: Approach, c: Candidate, passed: GateResult[], active: string[], projections: Projection[], usedModel: boolean) {
  const s = c.evaluation?.scores;
  return `# ${idea.ideaId} — ${idea.title}

**Status:** first cut, for comparison. The producer selects what becomes the episode.

| | |
|---|---|
| Question | ${idea.question} |
| Source | ${idea.source} |
| Proposed by | ${idea.contributor.credit ? idea.contributor.name : "anonymous patron"} (reuse: ${idea.contributor.reuse}) |
| Approach | ${a.title} — ${a.deliverable} |
| Runtime | ${a.runtimeMinutes} min |
| Stopping rule | ${a.stoppingRule} |
| Estimate | ~$${a.estCashUsd} · ~${a.estHours}h _(projected, not booked)_ |
| Remaining ceiling | $${c.remaining.toFixed(2)} |
| ${nameOf(playedBy("accounting"))} | story ${s?.story ?? "—"} · business ${s?.business ?? "—"} · participation ${s?.participation ?? "—"} → ${c.evaluation?.recommend ?? "—"} |
| Signals | creative ${c.idea.signals.creative.join(", ") || "—"} · community ${c.idea.signals.community} · support $${c.idea.signals.financial} |
| Assembled by | ${usedModel ? "showrunner (model)" : "showrunner (template)"} |

## Gates passed (${active.length} active)

${passed.map((g) => `- **${g.gate}** — ${g.why}`).join("\n")}

## Cast projections

${projections.map((p) => `- ${p.character}: \`${p.repo}@${p.sha.slice(0, 7)}\` → \`${p.file}\` (${p.sources.length} source files)`).join("\n")}
`;
}

function report(
  episodeId: string,
  load: number,
  gates: string[],
  results: Array<{ c: Candidate; results: GateResult[] }>,
  cut: string[],
  queued: string[],
  explored: string[],
) {
  const row = (r: { c: Candidate; results: GateResult[] }) => {
    const failed = r.results.filter((g) => !g.pass);
    const state = cut.includes(r.c.idea.ideaId) ? "**cut**" : queued.includes(r.c.idea.ideaId) ? "queued (over capacity)" : failed.length ? "held" : "ready";
    return `| ${r.c.idea.ideaId} | ${r.c.idea.title.replace(/\|/g, "/")} | ${state} | ${failed.map((g) => `${g.gate}: ${g.why}`).join("; ").replace(/\|/g, "/") || "—"} |`;
  };
  return `# Gate report — ${episodeId}

${new Date().toISOString()}

- Open candidates (load): **${load}**
- Active gates: ${gates.join(", ") || "none"}
- Explored this tick: ${explored.join(", ") || "none"}
- Cut this tick: ${cut.join(", ") || "none"}
- Queued (ready, over capacity): ${queued.join(", ") || "none"}

| Idea | Title | State | Why held |
|---|---|---|---|
${results.map(row).join("\n") || "| — | No open candidates | | |"}
`;
}

export { DEFAULT_CEILING };
