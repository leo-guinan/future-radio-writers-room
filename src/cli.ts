// The producer's console. Every command writes to the same log the workshop reads.
//
//   npm run room -- <command> [args] [--flags]
//
// Run `npm run room -- help` for the full list.

import { openRoom, LOG_PATH } from "./core/open.ts";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { RuleError } from "./core/room.ts";
import { EPISODE_STAGES, IDEA_EXITS, IDEA_STAGES, type Character, type EpisodeStage, type IdeaStatus, type LedgerEntry, type OutputKind, type SignalKind } from "./core/types.ts";
import { makeLLM } from "./agents/llm.ts";
import { ask, explore } from "./agents/characters.ts";
import { account, checklist, fileSha, LOOP, nextStep } from "./production/loop.ts";
import { seed } from "./seed.ts";
import { importAll, importEpisode } from "./production/import.ts";
import { tick } from "./showrunner/showrunner.ts";
import { dressingRoom } from "./repos/dressing-room.ts";
import { EpisodeRepo } from "./repos/episode-repo.ts";
import { localRepos, planPublish, publish } from "./repos/publish.ts";
import { REPOS_DIR } from "./repos/git.ts";
import { syncAll } from "./repos/sync.ts";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { castFile, isPrincipal, principals } from "./core/cast.ts";
import { extrasRepo, slugify } from "./repos/extras.ts";
import { readFileSync } from "node:fs";
import { closeScene, openScene, runScene, sceneMarkdown, transcript } from "./scenes/scenes.ts";
import { lineAudio } from "./scenes/voice.ts";
import { designVoice, selectDesignedVoice } from "./scenes/abilities.ts";
import { collect, defaultSince, readAssets, recordDaily, today, writeAssets, type Digest } from "./daily/daily.ts";
import { spawnRoom } from "./spawn/spawn.ts";
import { castingFor, loadCards, modelReport, playEpisode, revealTrial, runTrial, trialMarkdown, type Lineup } from "./scenes/trials.ts";

/** A character's home: their dressing room, or their folder in the extras. */
function homeFor(slug: string) {
  if (isPrincipal(slug)) return dressingRoom(slug);
  const x = extrasRepo();
  if (x.repo.exists && x.has(slug)) return x.extra(slug);
  throw new RuleError("usage", `No dressing room or extra called ${slug}. Principals: ${principals().join(", ")}. Extras: ${x.repo.exists ? x.list().join(", ") || "none" : "none"}.`);
}

const INTAKE = process.env.INTAKE_EPISODE ?? "E02";

const PRODUCER = process.env.PRODUCER_NAME ?? "leo";

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = "true";
      else (flags[key] = next), i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

const need = (v: string | undefined, what: string) => {
  if (!v) throw new RuleError("usage", `Missing ${what}. Run \`npm run room -- help\`.`);
  return v;
};
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const out = (x: unknown) => console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));

const HELP = `Future Radio writers' room — producer console

Setup
  seed [--fresh] [--media dir]           Start an empty room from seed/room-log.jsonl (the published record),
                                         or with --fresh from seed/season-1.json + seed/episodes/*
  publish-log                            Copy the room's log to seed/room-log.jsonl (the public record)
  import <folder> [--media dir]          Import a released episode (idempotent)
  verify                                 Check the hash chain of the event log
  serve                                  Start the workshop server (same as npm start)

Season & episodes
  status [EP]                            Season overview, or one episode's checklist and next step
  episode advance EP <stage> [--note]    Move to the next stage: ${EPISODE_STAGES.slice(1).join(" → ")}
  episode select EP SCENE yes|no --reason "..."
  episode asset EP <kind> <label> <path|url> [--private]   kind: script|audio|music|sfx|art|notes|other
  episode release EP <file> --invitation "..." [--version v1] [--script file] [--runtime min]
  episode release EP --sha256 HEX --uri URL --invitation "..." [--script-sha256 HEX]   (file published elsewhere)
  episode account EP --hours N|--days N --learned "..." [--cash USD --evidence ref] [--revisions N] [--who name]
  budget EP <new-ceiling> --reason "..."

Ideas
  idea add --title ... --question ... --source ... [--output scene] [--episode EP] [--by name]
  idea move ID <${[...IDEA_STAGES, ...IDEA_EXITS].join("|")}> --reason "..." [--result ...] [--capability ...] [--merged-into ID] [--cash N --hours N]
  signal ID creative|community|financial <value> [--receipt ref] [--note ...]
  board                                  Ideas with their three separate signals

The characters
  explore ID                             memory remembers → making creates → accounting evaluates (cast in cast.json)
  ask <character|role> "..." [--idea ID] [--public]   roles: memory, making, accounting

Scenes (characters playing a scene together; text unless someone asks to hear it)
  scene open <card.json> [--run] [--steps N]   Card: title, setting, situation, stakes, stoppingRule, maxTurns,
                                         episodeId?, ideaId?, cast: [{character, motivation}]  (see scenes/cards/)
  scene run S-0001 [--steps N]           Play on until the stopping rule or the turn limit
  scene close S-0001 --reason "..."      Stop it here and reveal the motivations
  scene show S-0001 [--md]               The transcript (motivations once closed; the producer sees them always)
  scene list                             Every scene and where it stands
  scene voice S-0001 <n> [--out f.mp3]   Voice one line just in time (cached; needs ELEVENLABS_API_KEY)
  scene play <cards.json> [--lineup N]   Play an episode of cards in order (each scene remembers the earlier ones)

Designed voices (ElevenLabs Voice Design; needs ELEVENLABS_API_KEY; each design is a bill)
  voice design <character> "<description>" [--sample "100+ chars"]   Three candidates, kept for review
  voice designs                          Every design: who ordered it, for whom, and what was chosen
  voice pick VD-0001 <1-3> [--for slug] [--scene S-0001] [--name "..."]   Make one a voice
                                         (scoped to a scene and what follows it, or room-wide without --scene)
  In a scene card, "abilities": ["design-voice"] on a cast member lets them do it mid-scene.

New rooms and the morning episode
  spawn "<idea>" --name slug [--show "Title"] [--dir path] [--cast memory=x,making=y,accounting=z]
        [--assets none|a/b,c/d] [--publish --owner GH [--private]]
                                         A new writers' room for an idea, with known asset repos attached
  assets list | assets add owner/repo [--kind k] [--about "..."] | assets remove owner/repo
  daily [--day YYYY-MM-DD] [--since ISO]  Look over what people did since yesterday and today's goals; record an episode
        [--collect-only] [--digest-json '{...}'] [--md-only] [--no-write]

Blind tastings (the same cards under different models, judged without knowing which is which)
  trial run <cards.json> [--lineups l.json] [--sequential]   Play every line-up, open tasting T-0001 as A, B, C…
  trial list | trial show T-0001 [--md]  The versions, blind until revealed
  trial feedback T-0001 --favorite B [--themselves leonardo=A,agnolo=C] [--note "..."]
  trial reveal T-0001 [--out file.md]    Unblind: line-ups, tally and cost; runs go to the dressing rooms
  trial report                           Every revealed tasting, per character and model
  Models are OpenRouter ids (OPENROUTER_API_KEY); defaults per character live in cast.json "models".

Showrunner & repos
  showrunner tick EP [--no-explore] [--assigned-only]   Explore, gate, and assemble first cuts into the episode repo
  showrunner gates EP                    Active gates and why each open candidate is held
  remember <character> "note" [--source ref]  Add a durable note to a dressing room or an extra's folder
  repos list                             Dressing rooms and episode repos, with heads
  repos publish --owner GH_OWNER [--public] [--yes]   Create/push GitHub repos (dry run without --yes)
  repos sync                             Pull merged viewer PRs into dressing rooms, rebuild bibles, push

Extras (characters without a story of their own yet)
  extras list | extras status [slug]     Who's here, where they've turned up, and the case for promotion
  extras open <slug> [--name "The cat"]  Give someone a folder (sketch from seed/extras/<slug>.md if present)
  extras promote <slug> --reason "..."   Move them, with their git history, into a dressing room of their own

Character bibles
  bible build [character]                Rebuild bible/ for one character, or everyone (principals and extras)
  bible show <character>                 Print the character's loadable system prompt
  bible chat <character> [--from name]   Talk with a principal or an extra locally; /propose drafts a viewer note

Station (24-hour Future Radio; frame at /station, open feeds at /station/feed/*; see STATION.md)
  station now | grid [--hours N] | rules
  station program --text "watch tenso and react when someone mentions me"   (or --voice-file f.wav)
  station approve P-0001 | station poll | station voice-cache DIR

HumAIn OS (voice-first, human-time-bounded sessions; web UI at /humain)
  humain demo [--idea "..."] [--ceiling N] [--secs N] [--voice-file f.wav] [--live] [--reserve N]
                                         Run the demo end to end (simulated speech, or real
                                         muse-voice-transcribe-1.0 with MODEL_API_KEY;
                                         --live fails visibly without Meta APIs)
  humain revise EPISODE [--feedback "..."] [--ceiling N] [--secs N] [--voice-file f.wav] [--live]
                                         Revise a cut (take N -> N+1) from spoken
                                         feedback; strict muse-spark-1.3, no offline planner
  humain replay H-0001                   Terminal replay of a session's events from the log
  humain evidence H-0001                 Observed/estimated/unknown costs, time, reuse evidence
  humain frames                          Persistent shareable frames and their visit counts
  humain budget                          Today's human time usage against the 60-minute budget

Agnolo's screen
  scorecard                              Observed / projected / disputed / unknown, three ledgers
  ledger add --ledger operations|historical|effort --kind expense|receipt|hours|obligation
             --amount N --label ... [--unit usd] [--status observed] [--evidence ref] [--episode EP] [--who name]
  forecast list | forecast resolve F-001 supported|failed|unresolved --observation "..." [--evidence ref]
  conference opening|framing|weekly|final "Title" --exhibits ev_000001,ev_000002 --notes "..."
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parse(rest);
  if (!cmd || cmd === "help") return out(HELP);
  if (cmd === "serve") return void (await import("./server.ts"));

  const room = openRoom();
  const by = flags.by ?? PRODUCER;

  switch (cmd) {
    case "seed": {
      // A published room log is the room's record so far: start from it rather than re-seeding,
      // so event ids and hashes match what dressing rooms and episode repos already cite.
      const published = join(process.cwd(), "seed", "room-log.jsonl");
      if (!room.store.all().length && existsSync(published) && !flags.fresh) {
        mkdirSync(dirname(LOG_PATH), { recursive: true });
        copyFileSync(published, LOG_PATH);
        const restored = openRoom();
        const v = restored.store.verify();
        if (!v.ok) throw new RuleError("immutable", `seed/room-log.jsonl fails verification at ${v.at}: ${v.reason}`);
        out(`Restored the published room log: ${v.count} events, head ${v.head.slice(0, 12)}.`);
        for (const r of importAll(restored, undefined, { actor: PRODUCER, mediaDir: flags.media }))
          out(`${r.episodeId}: ${r.recorded ? `imported, ${r.events} events` : "already in the log"}`);
        return;
      }
      const n = seed(room, PRODUCER);
      out(`Seeded ${n} events into ${LOG_PATH}. Episode 10 is at 'select' with ${[...room.mustEpisode("E10").scenes.values()].filter((s) => s.selected).length} scenes selected.`);
      for (const r of importAll(room, undefined, { actor: PRODUCER, mediaDir: flags.media }))
        out(`Imported ${r.episodeId}: ${r.events} events · ${r.appearances.map((a) => `${a.character} ${a.lines} lines`).join(", ")} · ${r.canonAdded} canon notes${r.repo ? ` · ${r.repo.name}@${r.repo.sha.slice(0, 7)}` : ""}${r.missingMedia.length ? ` · media not copied: ${r.missingMedia.length}` : ""}`);
      return;
    }
    case "import": {
      const dir = need(pos[0], "episode folder (e.g. seed/episodes/e01)");
      const r = importEpisode(room, dir, { actor: PRODUCER, mediaDir: flags.media });
      return out(r);
    }
    case "publish-log": {
      const v = room.store.verify();
      if (!v.ok) throw new RuleError("immutable", `The log fails verification at ${v.at}; not publishing it.`);
      copyFileSync(LOG_PATH, join(process.cwd(), "seed", "room-log.jsonl"));
      return out(`seed/room-log.jsonl ← ${v.count} events, head ${v.head.slice(0, 12)}. Commit it to publish.`);
    }
    case "verify":
      return out(room.store.verify());

    case "status": {
      if (pos[0]) {
        const ep = room.mustEpisode(pos[0]);
        const next = nextStep(room, ep.episodeId);
        out(`${ep.episodeId} "${ep.title}" — stage: ${ep.stage} · cash $${room.episodeCash(ep.episodeId).toFixed(2)} / $${ep.ceiling.toFixed(2)} · hours ${room.episodeHours(ep.episodeId)}${room.episodeDays(ep.episodeId) ? ` · days ${room.episodeDays(ep.episodeId)}` : ""}`);
        for (const c of checklist(room, ep.episodeId)) out(`  [${c.done ? "x" : " "}] ${c.task}${"detail" in c && c.detail ? `  (${c.detail})` : ""}`);
        if (next) out(`\nNext: ${next.stage} — ${next.does}`);
        for (const r of ep.releases) out(`Released ${r.version}: ${r.uri} sha256:${r.sha256.slice(0, 16)}… (locked)`);
        return;
      }
      for (const e of room.scorecard().episodes)
        out(`${e.episodeId.padEnd(4)} ${e.stage.padEnd(9)} $${e.cash.toFixed(2).padStart(6)} / $${e.ceiling.toFixed(0).padEnd(4)} ${String(e.hours).padStart(5)}h  ${e.title}${e.released.length ? `  [released ${e.released.join(",")}]` : ""}`);
      return;
    }

    case "episode": {
      const [sub, epId] = pos;
      need(epId, "episode id");
      if (sub === "advance") return out(room.advanceEpisode(by, epId, need(pos[2], "stage") as EpisodeStage, flags.note).id);
      if (sub === "select")
        return out(room.selectScene(by, { episodeId: epId, sceneId: need(pos[2], "scene id"), selected: pos[3] !== "no", reason: need(flags.reason, "--reason") }).id);
      if (sub === "asset") {
        const uri = need(pos[4], "path or url");
        let hash: string | undefined = flags.sha256;
        if (!hash) try { hash = fileSha(uri); } catch { hash = undefined; }
        return out(room.addAsset(by, { episodeId: epId, kind: need(pos[2], "kind") as any, label: need(pos[3], "label"), uri, sha256: hash }, flags.private ? "producer" : "public").id);
      }
      if (sub === "release") {
        // Either a local file (hashed here), or --sha256 and --uri for a file published elsewhere.
        const file = flags.sha256 ? undefined : need(pos[2], "released file (or --sha256 and --uri)");
        const ev = room.release(by, {
          episodeId: epId,
          version: flags.version ?? `v${room.mustEpisode(epId).releases.length + 1}`,
          uri: flags.uri ?? need(file, "--uri"),
          sha256: flags.sha256 ?? fileSha(file!),
          scriptSha256: flags["script-sha256"] ?? (flags.script ? fileSha(flags.script) : undefined),
          runtimeMinutes: num(flags.runtime),
          invitation: need(flags.invitation, "--invitation"),
        });
        return out(`Released and locked: ${ev.id} sha256 ${(ev.payload as any).sha256}`);
      }
      if (sub === "account")
        return out(
          account(room, by, epId, {
            cashUsd: num(flags.cash),
            cashEvidence: flags.evidence,
            hours: num(flags.hours),
            days: num(flags.days),
            who: flags.who,
            revisions: num(flags.revisions),
            learned: need(flags.learned, "--learned (what should improve next time)"),
          }).id,
        );
      throw new RuleError("usage", `Unknown episode subcommand ${sub}`);
    }
    case "budget":
      return out(room.authorizeBudget(by, { episodeId: need(pos[0], "episode id"), newCeiling: Number(need(pos[1], "ceiling")), reason: need(flags.reason, "--reason") }).id);

    case "idea": {
      const sub = pos[0];
      if (sub === "add") {
        const ev = room.proposeIdea(by, {
          title: need(flags.title, "--title"),
          question: need(flags.question, "--question"),
          source: need(flags.source, "--source"),
          output: (flags.output ?? "scene") as OutputKind,
          episodeId: flags.episode,
          contributor: { name: flags.by ?? "Leo", credit: true, reuse: (flags.reuse as any) ?? "cc-by" },
        });
        return out(`${(ev.payload as any).ideaId} proposed (${ev.id})`);
      }
      if (sub === "move")
        return out(
          room.transitionIdea(by, {
            ideaId: need(pos[1], "idea id"),
            to: need(pos[2], "status") as IdeaStatus,
            reason: need(flags.reason, "--reason"),
            result: flags.result,
            capability: flags.capability,
            mergedInto: flags["merged-into"],
            actual: flags.cash || flags.hours ? { cash: num(flags.cash), hours: num(flags.hours) } : undefined,
          }).id,
        );
      throw new RuleError("usage", `Unknown idea subcommand ${sub}`);
    }
    case "signal":
      return out(
        room.signal(by, {
          ideaId: need(pos[0], "idea id"),
          kind: need(pos[1], "kind") as SignalKind,
          value: Number(need(pos[2], "value")),
          receipt: flags.receipt,
          note: flags.note,
        }).id,
      );
    case "board": {
      const rows = room.board();
      for (const r of rows)
        out(`${r.ideaId} ${r.status.padEnd(9)} creative ${r.creative === null ? " –" : r.creative.toFixed(1)} · community ${String(r.community).padStart(3)} · $${r.financial.toFixed(2).padStart(7)}  ${r.title}`);
      return;
    }

    case "explore": {
      const llm = makeLLM();
      const r = await explore({ room, llm, askedBy: by, scope: "producer" }, need(pos[0], "idea id"));
      out(`BORGES: ${r.memory.text}\n\nLEONARDO: ${r.created.text}`);
      r.created.approaches.forEach((a, i) => out(`  ${i + 1}. ${a.title} — ${a.deliverable} · ${a.runtimeMinutes} min · ~$${a.estCashUsd} · ~${a.estHours}h\n     stop: ${a.stoppingRule}`));
      out(`\nAGNOLO: ${r.judged.text}`);
      out(r.judged.evaluation);
      out(r.judged.budget);
      if (llm.offline) out("\n(offline: set ANTHROPIC_API_KEY for the characters' own voices)");
      return;
    }
    case "ask": {
      const llm = makeLLM();
      const r = await ask({ room, llm, askedBy: by, scope: flags.public ? "public" : "producer" }, need(pos[0], "character") as Character, need(pos[1], "question"), flags.idea);
      return out(r.text);
    }

    case "scene": {
      const llm = makeLLM();
      const ctx = { room, llm, askedBy: by };
      const steps = flags.steps ? Number(flags.steps) : undefined;
      const sub = pos[0];
      if (sub === "open") {
        const card = JSON.parse(readFileSync(need(pos[1], "card.json"), "utf8"));
        const { cast, ...rest } = card;
        const s = openScene(ctx, rest, cast ?? []);
        out(`${s.sceneId} opened: ${s.title} (${s.cast.join(", ")}, at most ${s.maxTurns} lines)`);
        if (!flags.run) return;
        const done = await runScene(ctx, s.sceneId, { maxSteps: steps });
        out(`\n${transcript(done)}`);
        if (done.closed) out(`\n— closed: ${done.closed.reason}`);
        if (llm.offline) out("\n(offline: set ANTHROPIC_API_KEY for the characters' own lines)");
        return;
      }
      if (sub === "run") {
        const done = await runScene(ctx, need(pos[1], "scene id"), { maxSteps: steps });
        out(transcript(done));
        if (done.closed) out(`\n— closed: ${done.closed.reason}`);
        return;
      }
      if (sub === "close") {
        const s = room.mustScene(need(pos[1], "scene id"));
        closeScene(ctx, s, need(flags.reason, "--reason"));
        return out(`${s.sceneId} closed.`);
      }
      if (sub === "show") {
        const s = room.mustScene(need(pos[1], "scene id"));
        if (flags.md) return out(sceneMarkdown(s, s.closed?.reason));
        out(`${s.sceneId} — ${s.title}${s.closed ? ` (closed: ${s.closed.reason})` : ` (${s.turns.length}/${s.maxTurns})`}\n`);
        out(transcript(s));
        out(`\nMotivations:\n${s.cast.map((c) => `  ${c}: ${s.motivations[c]}`).join("\n")}`);
        return;
      }
      if (sub === "play") {
        const ep = loadCards(need(pos[1], "cards.json"));
        const lineup: Lineup | undefined = flags.lineup ? ep.lineups?.[Number(flags.lineup) - 1] : undefined;
        if (flags.lineup && !lineup) throw new RuleError("usage", `No line-up ${flags.lineup} in that file.`);
        if (lineup) out(`Casting: ${Object.entries(castingFor(ep, lineup)).map(([k, m]) => `${k}=${m}`).join(" ")}`);
        const ids = await playEpisode(ctx, ep, { lineup });
        for (const id of ids) out(`\n## ${room.mustScene(id).title} (${id})\n${transcript(room.mustScene(id))}`);
        if (llm.offline) out("\n(offline: set OPENROUTER_API_KEY for the characters' own lines)");
        return;
      }
      if (sub === "list" || !sub) {
        for (const s of room.scenes.values()) out(`${s.sceneId} ${(s.closed ? "closed" : "open").padEnd(6)} ${String(s.turns.length).padStart(2)}/${s.maxTurns} lines  ${s.title}`);
        return;
      }
      if (sub === "voice") {
        const r = await lineAudio(room, need(pos[1], "scene id"), Number(need(pos[2], "line number")), { requestedBy: by });
        if (flags.out) copyFileSync(r.path, flags.out);
        return out(`${r.generated ? "generated" : "from cache"}: ${flags.out ?? r.path}`);
      }
      throw new RuleError("usage", "scene open|run|close|show|list|voice");
    }

    case "voice": {
      const sub = pos[0];
      if (sub === "design") {
        const d = await designVoice(room, { by, forCharacter: need(pos[1], "character"), description: need(pos[2], "description"), sample: flags.sample, mode: "offer" });
        out(`${d.designId}: ${d.previews.length} candidates for ${d.forCharacter}${d.costUsd === null ? " (cost unknown; set VOICE_DESIGN_PRICE_USD)" : ` ($${d.costUsd.toFixed(2)})`}`);
        for (const p of d.previews) out(`  ${p.k}. ${p.file}${p.durationSecs ? ` · ${p.durationSecs.toFixed(1)}s` : ""}`);
        return out(`Listen on the workshop page, then: voice pick ${d.designId} <1-3>`);
      }
      if (sub === "pick") {
        const r = await selectDesignedVoice(room, need(pos[1], "design id"), Number(need(pos[2], "1-3")), { by, character: flags.for, name: flags.name, sceneId: flags.scene });
        return out(`${r.character} speaks with "${r.name}" (${r.voiceId})${flags.scene ? ` in ${flags.scene} and the scenes that follow it` : " everywhere in this room"}.`);
      }
      if (sub === "designs" || !sub) {
        for (const d of room.voiceDesigns.values())
          out(`${d.designId} ${d.at.slice(0, 16)} ${d.by} → ${d.forCharacter} (${d.mode}${d.sceneId ? `, ${d.sceneId}` : ""}): "${d.description.slice(0, 80)}"${d.selected.length ? `  chosen: ${d.selected.map((v) => v.k).join(", ")}` : ""}`);
        return;
      }
      throw new RuleError("usage", "voice design|designs|pick");
    }
    case "spawn": {
      const cast = Object.fromEntries((flags.cast ?? "").split(",").filter(Boolean).map((kv) => kv.split("=").map((x) => x.trim())));
      const known = readAssets();
      const assets =
        flags.assets === "none" ? [] : flags.assets ? flags.assets.split(",").map((r) => known.find((a) => a.repo === r.trim()) ?? { repo: r.trim() }) : undefined;
      const r = spawnRoom({
        idea: need(pos[0], "an idea, in quotes"),
        name: need(flags.name, "--name"),
        show: flags.show,
        dir: flags.dir,
        question: flags.question,
        cast,
        assets,
        owner: flags.owner,
        publish: !!flags.publish,
        visibility: flags.private ? "private" : "public",
      });
      out(`Spawned ${r.dir}: ${r.files} engine files, ${r.assets.length} asset repo${r.assets.length === 1 ? "" : "s"} attached${r.repo ? `, pushed to github.com/${r.repo}` : ""}.`);
      for (const a of r.assets) out(`  + ${a.repo}${a.about ? ` — ${a.about}` : ""}`);
      out(`\nNext: cd ${r.dir} && npm install && npm run room -- daily`);
      if (r.repo) out(`Add an OPENROUTER_API_KEY secret to ${r.repo} so the morning episode has the characters' own lines.`);
      return;
    }
    case "assets": {
      const list = readAssets();
      if (pos[0] === "add") {
        const repo = need(pos[1], "owner/repo");
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new RuleError("usage", "owner/repo");
        writeAssets([...list.filter((a) => a.repo !== repo), { repo, ...(flags.kind ? { kind: flags.kind } : {}), ...(flags.about ? { about: flags.about } : {}) }]);
        return out(`Attached ${repo}.`);
      }
      if (pos[0] === "remove") {
        writeAssets(list.filter((a) => a.repo !== pos[1]));
        return out(`Detached ${pos[1]}.`);
      }
      for (const a of list) out(`${a.repo.padEnd(48)} ${(a.kind ?? "").padEnd(11)} ${a.about ?? ""}`);
      return;
    }
    case "daily": {
      const day = flags.day ?? today();
      const since = flags.since ?? (flags.day ? new Date(new Date(`${day}T00:00:00Z`).getTime() - 24 * 3600 * 1000).toISOString() : defaultSince());
      const roomRepo = { dir: process.cwd(), name: (() => { try { return JSON.parse(readFileSync("package.json", "utf8")).name; } catch { return "this room"; } })() };
      let digest: Digest;
      if (flags["digest-json"]) digest = JSON.parse(flags["digest-json"]);
      else if (flags.digest) digest = JSON.parse(readFileSync(flags.digest, "utf8"));
      else digest = collect({ day, since, roomRepo });
      if (flags["collect-only"]) return out(JSON.stringify({ ...digest, commits: digest.commits.slice(-200) }));
      if (!room.store.all().length && existsSync(join(process.cwd(), "seed", "season-1.json"))) seed(room, by);
      const llm = makeLLM();
      const r = await recordDaily({ room, llm, askedBy: by }, digest, { write: !flags["no-write"] });
      if (flags["md-only"]) return out(r.markdown);
      out(r.markdown);
      out(`\nDaily episode ${r.number} (${r.phase}) → ${r.file ?? "not written"}${llm.offline ? "\n(offline: set OPENROUTER_API_KEY for the characters' own lines)" : ""}`);
      return;
    }

    case "trial": {
      const llm = makeLLM();
      const ctx = { room, llm, askedBy: by };
      const sub = pos[0];
      if (sub === "run") {
        const ep = loadCards(need(pos[1], "cards.json"));
        const lineups: Lineup[] = flags.lineups ? JSON.parse(readFileSync(flags.lineups, "utf8")) : ep.lineups ?? [];
        if (llm.offline) out("(offline: every version will be placeholders; set OPENROUTER_API_KEY)");
        const t = await runTrial(ctx, ep, lineups, { parallel: !flags.sequential });
        return out(`${t.trialId} open: ${t.entries.map((e) => e.label).join(", ")} — ${t.title}. Blind until \`trial reveal ${t.trialId}\`.`);
      }
      if (sub === "list" || !sub) {
        for (const t of room.trials.values()) out(`${t.trialId} ${t.revealed ? "revealed" : "blind   "} ${t.entries.length} versions · ${t.feedback.length} responses  ${t.title}`);
        return;
      }
      if (sub === "show") {
        const id = need(pos[1], "tasting id");
        if (flags.md) return out(trialMarkdown(room, id));
        const t = room.mustTrial(id);
        out(`${t.trialId} — ${t.title}\n${t.question}\n`);
        for (const e of t.entries) out(`${e.label}: ${e.sceneIds.join(", ")}${t.revealed ? `  ${Object.values(t.revealed.lineups[e.label].models).join(", ")}` : ""}`);
        for (const f of t.feedback) out(`  ${f.by}: ${f.favorite}${f.note ? ` — ${f.note}` : ""}`);
        return;
      }
      if (sub === "feedback") {
        const id = need(pos[1], "tasting id");
        const mostThemselves = Object.fromEntries((flags.themselves ?? "").split(",").filter(Boolean).map((kv) => kv.split("=").map((x) => x.trim())));
        room.addTrialFeedback(by, { trialId: id, name: by, favorite: need(flags.favorite, "--favorite"), mostThemselves, note: flags.note });
        return out(`Noted on ${id}.`);
      }
      if (sub === "reveal") {
        const id = need(pos[1], "tasting id");
        revealTrial(ctx, id);
        const md = trialMarkdown(room, id);
        if (flags.out) {
          mkdirSync(dirname(flags.out), { recursive: true });
          (await import("node:fs")).writeFileSync(flags.out, md);
        }
        return out(md);
      }
      if (sub === "report") {
        const rows = modelReport(room);
        if (!rows.length) return out("No revealed tastings yet.");
        for (const r of rows) out(`${r.character.padEnd(14)} ${r.model.padEnd(36)} most themselves ${r.mostThemselves}/${r.votes} · ${r.tastings} tasting${r.tastings === 1 ? "" : "s"}, ${r.versions} version${r.versions === 1 ? "" : "s"} · favourite share ${(r.favoriteShare * 100).toFixed(0)}%`);
        return;
      }
      throw new RuleError("usage", "trial run|list|show|feedback|reveal|report");
    }

    case "scorecard":
      return out(room.scorecard());
    case "ledger": {
      if (pos[0] !== "add") throw new RuleError("usage", "ledger add ...");
      const kind = need(flags.kind, "--kind") as LedgerEntry["kind"];
      return out(
        room.addLedgerEntry(by, {
          ledger: need(flags.ledger, "--ledger") as LedgerEntry["ledger"],
          kind,
          amount: Number(need(flags.amount, "--amount")),
          unit: (flags.unit as LedgerEntry["unit"]) ?? (kind === "hours" ? "hours" : "usd"),
          status: (flags.status as LedgerEntry["status"]) ?? "observed",
          label: need(flags.label, "--label"),
          evidence: flags.evidence,
          episodeId: flags.episode,
          ideaId: flags.idea,
          who: flags.who,
        }, flags.public ? "public" : "producer").id,
      );
    }
    case "forecast": {
      if (pos[0] === "list") {
        for (const f of room.forecasts.values()) out(`${f.forecastId} [${f.resolution?.outcome ?? "open"}] due ${f.dueBy}: ${f.claim}`);
        return;
      }
      if (pos[0] === "resolve")
        return out(room.resolveForecast(by, { forecastId: need(pos[1], "forecast id"), outcome: need(pos[2], "outcome") as any, observation: need(flags.observation, "--observation"), evidence: flags.evidence }).id);
      throw new RuleError("usage", "forecast list | forecast resolve ...");
    }
    case "conference":
      return out(
        room.holdConference(by, {
          kind: need(pos[0], "kind") as any,
          title: need(pos[1], "title"),
          exhibits: (flags.exhibits ?? "").split(",").filter(Boolean),
          notes: flags.notes ?? "",
        }).id,
      );
    case "showrunner": {
      const [sub, epId] = pos;
      if (sub === "tick") {
        const llm = makeLLM();
        const t = await tick(room, llm, need(epId, "episode id"), { explore: !flags["no-explore"], includeUnassigned: flags["assigned-only"] ? false : epId === INTAKE });
        out(`${t.episodeId}: load ${t.load} · gates ${t.activeGates.join(", ")}`);
        if (t.explored.length) out(`  explored: ${t.explored.join(", ")}`);
        out(`  cut: ${t.cut.join(", ") || "none"}${t.queued.length ? ` · queued: ${t.queued.join(", ")}` : ""}`);
        for (const h of t.held) out(`  held ${h.ideaId}: ${h.failed.map((f) => `${f.gate} (${f.why})`).join("; ")}`);
        out(`  repo ${new EpisodeRepo(t.episodeId).repo.dir} @ ${t.repoSha.slice(0, 7)}`);
        return;
      }
      if (sub === "gates") {
        const repo = new EpisodeRepo(need(epId, "episode id"));
        if (!repo.repo.exists) return out(`No repo for ${epId} yet. Run: showrunner tick ${epId}`);
        return out(repo.repo.read("GATES.md"));
      }
      throw new RuleError("usage", "showrunner tick EP | showrunner gates EP");
    }
    case "remember": {
      return out(homeFor(need(pos[0], "character")).remember(need(pos[1], "note"), flags.source ?? by));
    }
    case "extras": {
      const x = extrasRepo().ensure();
      const sub = pos[0] ?? "list";
      if (sub === "list" || sub === "status") {
        const who = sub === "status" && pos[1] ? [pos[1]] : x.list();
        if (!who.length) out("No extras yet. Open one with: npm run room -- extras open <slug>");
        for (const slug of who) {
          const s = x.signals(slug, room);
          out(`${s.worthConsidering ? "★" : " "} ${s.slug.padEnd(24)} ${s.name}`);
          out(`    released in ${s.appearances.join(", ") || "nothing yet"} · ${s.viewerNotes} viewer note(s) · ideas ${s.ideas.join(", ") || "none"} (${s.votes} vote(s)) · ${s.openQuestions} open question(s)`);
        }
        const t = castFile().promotion;
        out(`\n★ worth considering for a dressing room: ${t.appearances}+ released appearances and either ${t.viewerNotes}+ viewer notes or ${t.votes}+ votes. You decide.`);
        for (const p of x.promoted()) out(`  promoted: ${p.slug}`);
        return;
      }
      if (sub === "open") {
        const slug = slugify(need(pos[1], "slug"));
        const home = x.open(slug, { name: flags.name });
        room.store.append("repo.commit", by, { repo: home.repo.name, sha: home.repo.head(), message: `Opened ${home.bible().name}'s folder in the extras`, files: [`${slug}/CHARACTER.md`] }, "public");
        return out(`${slug}: ${home.repo.dir}\nEdit ${slug}/CHARACTER.md to sketch them (or add seed/extras/${slug}.md before opening).`);
      }
      if (sub === "promote") {
        const slug = need(pos[1], "slug");
        const before = x.signals(slug, room);
        const r = x.promote(slug, need(flags.reason, "--reason (why they've earned it)"));
        room.store.append("repo.commit", by, { repo: r.dressingRoom.repo.name, sha: r.dressingRoom.repo.head(), message: `Promoted ${before.name} from the extras: ${flags.reason}`, files: ["CHARACTER.md", "history.jsonl"] }, "public");
        room.store.append("repo.commit", by, { repo: "extras", sha: r.extrasSha, message: `${before.name} left a forwarding note`, files: [`${slug}/PROMOTED.md`] }, "public");
        out(`${before.name} has a dressing room: ${r.dressingRoom.repo.dir} (${r.carried} commits of history carried over).`);
        out(`cast.json now lists them as a principal — commit it. To publish: create ${process.env.REPO_PREFIX ?? "future-radio-"}dressing-room-${slug} on GitHub and push, and push the extras.`);
        return;
      }
      throw new RuleError("usage", "extras list | extras status [slug] | extras open <slug> [--name 'The cat'] | extras promote <slug> --reason '...'");
    }
    case "bible": {
      const [sub, who] = pos;
      const pick = (w?: string): string[] => (w ? [w] : [...principals(), ...extrasRepo().list()]);
      if (sub === "build") {
        for (const c of pick(who)) out(`${c}: ${homeFor(c).ensure().refresh()} `);
        return;
      }
      const c = pick(need(who, "character"))[0];
      const dir = homeFor(c).ensure().repo.dir;
      const bin = createRequire(import.meta.url).resolve("future-radio-character-bible/bin/character-bible.js");
      if (sub === "show" || sub === "chat") {
        spawnSync(process.execPath, [bin, sub, dir, ...(flags.from ? ["--from", flags.from] : [])], { stdio: "inherit" });
        return;
      }
      throw new RuleError("usage", "bible build [character] | bible show <character> | bible chat <character>");
    }
    case "repos": {
      if (pos[0] === "list") {
        out(`Repos in ${REPOS_DIR()}`);
        for (const r of localRepos()) {
          const l = r.log(1)[0];
          out(`  ${r.name.padEnd(24)} ${l ? `${l.sha.slice(0, 7)} ${l.message}` : "(empty)"}${r.remote() ? `  → ${r.remote()}` : ""}`);
        }
        return;
      }
      if (pos[0] === "publish") {
        const steps = planPublish(need(flags.owner, "--owner (GitHub user or org)"), flags.public ? "public" : "private");
        if (!flags.yes) {
          out(`Dry run. Re-run with --yes to execute:`);
          for (const s of steps) out(`  ${s.action.padEnd(6)} ${s.target}\n         ${s.command.join(" ")}`);
          return;
        }
        // Point every dressing room's CI at the published bible tool before it goes up.
        const pkg = `github:${flags.owner}/future-radio-character-bible`;
        for (const c of principals()) dressingRoom(c).retarget(pkg);
        for (const r of publish(planPublish(flags.owner, flags.public ? "public" : "private"))) out(`${r.ok ? "✓" : "✗"} ${r.action} ${r.target}${r.ok ? "" : ` — ${r.error}`}`);
        return;
      }
      if (pos[0] === "sync") {
        for (const r of syncAll(room))
          out(`${r.status === "synced" ? "✓" : r.status === "no-remote" ? "·" : "✗"} ${r.repo.padEnd(24)} ${r.status}${r.pulled.length ? ` · ${r.pulled.length} in` : ""}${r.newViewerNotes.length ? ` · new viewer notes: ${r.newViewerNotes.join(", ")}` : ""}${r.message ? ` — ${r.message}` : ""}`);
        return;
      }
      throw new RuleError("usage", "repos list | repos publish --owner X [--public] [--yes] | repos sync");
    }
    case "loop":
      return out(LOOP.map((l) => `${l.stage.padEnd(9)} ${l.does}`).join("\n"));
    case "station": {
      const sub = pos[0] ?? "now";
      const { loadLineup, onAir, grid } = await import("./station/schedule.ts");
      if (sub === "now") {
        const a = onAir(loadLineup(), Date.now() / 1000);
        return out(`${a.ident ? "Station ident, then " : ""}${a.slot.program.title} (${Math.floor(a.offset / 60)}:${String(Math.floor(a.offset % 60)).padStart(2, "0")} in)`);
      }
      if (sub === "grid") {
        const g = grid(loadLineup(), Date.now() / 1000, Number(flags.hours ?? 3));
        return out(g.map((x) => `${new Date(x.start * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York" })}  ${x.program.title}`).join("\n"));
      }
      if (sub === "rules") {
        const { loadRules } = await import("./station/rules.ts");
        return out(JSON.stringify(loadRules(), null, 1));
      }
      if (sub === "program") {
        const { propose } = await import("./station/program.ts");
        const { readFileSync } = await import("node:fs");
        const c = await propose({ text: flags.text, wav: flags["voice-file"] ? readFileSync(flags["voice-file"]) : undefined });
        return out(JSON.stringify({ id: c.id, transcript: c.transcript, parser: c.parser, ops: c.ops, acceptance: c.acceptance }, null, 1) + `\nApprove with: station approve ${c.id}`);
      }
      if (sub === "approve") {
        const { approve } = await import("./station/program.ts");
        const r = approve(need(pos[1], "contract id (e.g. P-0001)"), by);
        return out(r.verified.map((v) => `${v.pass ? "PASS" : "FAIL"}  ${v.check}`).join("\n") || "Nothing to change.");
      }
      if (sub === "poll") {
        const { pollOnce } = await import("./station/watcher.ts");
        const { makeArchive } = await import("./station/archive.ts");
        return out(JSON.stringify(await pollOnce(makeArchive())));
      }
      if (sub === "voice-cache") {
        // Seed the voice cache from a folder of takes: index.json maps "SPEAKER" -> { "line": "file.mp3" }.
        const { cacheFile, VOICES } = await import("./station/tts.ts");
        const { readFileSync, copyFileSync, mkdirSync } = await import("node:fs");
        const { join, dirname } = await import("node:path");
        const dir = need(pos[1], "folder with index.json");
        const idx = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as Record<string, Record<string, string>>;
        let n = 0;
        for (const [sp, lines] of Object.entries(idx)) for (const [text, f] of Object.entries(lines)) {
          const c = cacheFile(VOICES[sp], text); mkdirSync(dirname(c), { recursive: true }); copyFileSync(join(dir, f), c); n++;
        }
        return out(`${n} lines cached`);
      }
      return out("station now | grid [--hours N] | rules | program --text \"...\" | --voice-file f.wav | approve P-0001 | poll");
    }
    case "humain": {
      const { SessionController } = await import("./humain/session.ts");
      const { loadWorks } = await import("./humain/frame-maker.ts");
      const { executePlan } = await import("./humain/reconcile.ts");
      const { MetaVoiceTranscriber, makePlanner } = await import("./humain/adapters.ts");
      const { inventory } = await import("./humain/capabilities.ts");
      const { bookEstimate, estimatePlan } = await import("./humain/estimate.ts");
      const { buildContract } = await import("./humain/contract.ts");
      const sub = pos[0] ?? "demo";
      if (sub === "replay") {
        const id = need(pos[1], "session id (e.g. H-0001)");
        const events = room.store.all().filter((e) => e.type.startsWith("humain.") && (e.payload as any).sessionId === id);
        if (!events.length) throw new RuleError("usage", `No HumAIn OS events for ${id}.`);
        for (const e of events) out(`${e.seq} ${e.id} ${e.ts} ${e.type} by ${e.actor}\n    ${JSON.stringify(e.payload).slice(0, 300)}`);
        return;
      }
      if (sub === "demo") {
        if (flags.live) process.env.HUMAIN_LIVE = "1";
        const { isLive } = await import("./humain/adapters.ts");
        const { HUMAN_BUDGET_MIN } = await import("./humain/session.ts");
        const idea = flags.idea ?? "Build a webpage comparing The First Transmission and The People vs The Future with one hook and a vintage visitor counter.";
        const s = SessionController.open(room, by, 2, flags["save-transcript"] === "true", Number(flags.reserve ?? 10));
        out(`Session ${s.sessionId}: 2-minute input window (simulated speech). Human budget ${HUMAN_BUDGET_MIN} min/day, reserved ${s.reserveMin} min.${isLive() ? " LIVE MODE: Meta APIs or visible failure." : ""}`);
        s.startRecording("demo: simulated microphone");
        if (flags["voice-file"]) {
          if (!MetaVoiceTranscriber.available()) throw new RuleError("usage", "--voice-file needs MODEL_API_KEY for muse-voice-transcribe-1.0.");
          const { readFileSync: readAudio } = await import("node:fs");
          const t = new MetaVoiceTranscriber();
          const { chunks, costUsd } = await t.transcribe(readAudio(flags["voice-file"]), "audio/wav");
          for (const c of chunks) s.ingestTranscript(c.text, c.final, t.id);
          out(`Voice: ${chunks.length} chunk(s) via ${t.id} (cost ${costUsd === null ? "unknown" : `$${costUsd}`})`);
          if (typeof costUsd === "number" && costUsd > 0)
            room.addLedgerEntry(by, { ledger: "operations", kind: "expense", amount: costUsd, unit: "usd", status: "observed", label: `muse-voice-transcribe-1.0 ${s.sessionId}`, evidence: s.sessionId }, "producer");
        } else {
          s.ingestTranscript(idea, true, "cli-demo/typed");
        }
        s.closeInput("demo: finished speaking");
        const planner = makePlanner();
        const { draft, costUsd, usage } = await planner.plan(s.ideaText(), { works: loadWorks() });
        const { allocateFrameIds: allocDemoFrames } = await import("./humain/frames.ts");
        const demoFrameDrafts = draft.tasks.filter((t) => t.frame);
        const demoAllocated = allocDemoFrames(demoFrameDrafts.length);
        demoFrameDrafts.forEach((t, i) => {
          t.frame = { ...t.frame!, frameId: demoAllocated[i] };
        });
        const plan = s.recordPlan({ idea: s.ideaText(), hook: draft.hook, planner: planner.id, tasks: draft.tasks.map((t, i) => ({ ...t, taskId: `${s.sessionId}-T${i + 1}` })) });
        out(`Plan (${planner.id}): hook "${plan.hook}" · ${plan.tasks.length} tasks (tokens in/out ${usage.input}/${usage.output}, cost ${costUsd === null ? "unknown" : `$${costUsd}`})`);
        if (typeof costUsd === "number" && costUsd > 0)
          room.addLedgerEntry(by, { ledger: "operations", kind: "expense", amount: costUsd, unit: "usd", status: "observed", label: `${planner.id} plan ${s.sessionId}`, evidence: s.sessionId }, "producer");
        else if (!planner.id.startsWith("offline/") && usage.input + usage.output > 0)
          room.addLedgerEntry(by, { ledger: "operations", kind: "expense", amount: usage.input + usage.output, unit: "tokens", status: "unknown", label: `${planner.id} plan ${s.sessionId} (unpriced)`, evidence: s.sessionId }, "producer");
        const inv = inventory();
        s.recordCapabilities({ reuse: inv.reuse, build: inv.build });
        out(`Capabilities: reuse ${inv.reuse.length} (${inv.reuse.map((r) => r.capability).join(", ")}) · build ${inv.build.length}`);
        const est = estimatePlan(plan);
        const recorded = s.recordEstimate({ ...est, forecastId: bookEstimate(room, by, s.sessionId, est) });
        out(`ESTIMATE: $${est.apiUsd} API · ${est.localHours}h local · ${est.executionSeconds}s (forecast, not a receipt)`);
        const { contract, frameTasks } = buildContract(s.sessionId, plan, { sessionId: s.sessionId, reuse: inv.reuse, build: inv.build }, recorded);
        s.recordContract(contract, frameTasks);
        out(`Contract: desired vs observed (${contract.observed.length} facts), satisfied ${contract.satisfied.length}, modifications ${contract.modifications.length}, acceptance ${contract.acceptance.length} tests`);
        s.approve(Number(flags.ceiling ?? 5), Number(flags.secs ?? 300));
        await executePlan(room, s, by);
        const st = s.state();
        for (const r of st.results) out(`  ${r.taskId} ${r.status} — ${r.detail}`);
        for (const f of st.frames) out(`  frame ${f.frameId}: "${f.hook.slice(0, 60)}" sha256:${f.sha256.slice(0, 12)} human:${f.visits} unique:${f.unique} verification:${f.verification}`);
        if (st.lastCheckpoint) out(`  checkpoint: ${st.lastCheckpoint.reason} — remaining: ${st.lastCheckpoint.remaining.join("; ") || "none"}`);
        if (st.accounting) {
          const a = st.accounting;
          out(`  time: human used ${a.humanUsedSecs}s of ${a.reserveMin * 60}s reserved (${a.humanReleasedSecs}s released) · autonomous ${a.autonomousSecs}s · daily budget ${a.humanBudgetMin} min`);
        }
        out(`Done: ${st.terminal?.detail} Spend $${st.spendUsd}. Replay: npm run room -- humain replay ${s.sessionId}`);
        return;
      }
      if (sub === "revise") {
        if (flags.live) process.env.HUMAIN_LIVE = "1";
        const { SparkPlanner, isLive } = await import("./humain/adapters.ts");
        const { HUMAN_BUDGET_MIN } = await import("./humain/session.ts");
        const { VOICE_HOURS_PER_RECORDING, buildReviseContract, buildReviseTasks, loadCritiques, loadCut, preservedLines, applyEdits, reuseLine, rewriteCount, validateEdits } = await import("./humain/cuts.ts");
        const { runAcceptance } = await import("./humain/observe.ts");
        const episode = need(pos[1], "episode (e.g. going-viral)");
        let cut;
        let take;
        try {
          ({ cut, take } = loadCut(episode));
        } catch (e: any) {
          throw new RuleError("usage", e?.message ?? String(e));
        }
        const feedback = flags.feedback ?? flags.idea ?? "Make the monitor easier to read and keep the story as is.";
        const s = SessionController.open(room, by, 2, flags["save-transcript"] === "true", Number(flags.reserve ?? 10), episode);
        out(`Session ${s.sessionId}: revising ${cut.title} take ${take} (2-minute input window, simulated speech). Human budget ${HUMAN_BUDGET_MIN} min/day, reserved ${s.reserveMin} min.${isLive() ? " LIVE MODE: Meta APIs or visible failure." : ""}`);
        s.startRecording("revise: simulated microphone");
        if (flags["voice-file"]) {
          if (!MetaVoiceTranscriber.available()) throw new RuleError("usage", "--voice-file needs MODEL_API_KEY for muse-voice-transcribe-1.0.");
          const { readFileSync: readAudio } = await import("node:fs");
          const t = new MetaVoiceTranscriber();
          const { chunks, costUsd } = await t.transcribe(readAudio(flags["voice-file"]), "audio/wav");
          for (const c of chunks) s.ingestTranscript(c.text, c.final, t.id);
          out(`Voice: ${chunks.length} chunk(s) via ${t.id} (cost ${costUsd === null ? "unknown" : `$${costUsd}`})`);
          if (typeof costUsd === "number" && costUsd > 0)
            room.addLedgerEntry(by, { ledger: "operations", kind: "expense", amount: costUsd, unit: "usd", status: "observed", label: `muse-voice-transcribe-1.0 ${s.sessionId}`, evidence: s.sessionId }, "producer");
        } else {
          s.ingestTranscript(feedback, true, "cli-revise/typed");
        }
        s.closeInput("revise: finished speaking");
        if (!SparkPlanner.available()) throw new RuleError("usage", "humain revise needs MODEL_API_KEY for muse-spark-1.3 (strict live mode; no offline revise planner).");
        const planner = new SparkPlanner();
        const { draft, costUsd, usage } = await planner.planRevise(s.ideaText(), cut, loadCritiques(episode, take));
        const errs = validateEdits(cut, draft.edits, draft.feedback.map((f) => f.id), draft.declined);
        if (errs.length) throw new RuleError("humain", `Spark's revision failed validation (nothing was applied): ${errs.join("; ")}`);
        const plan = s.recordPlan({ idea: s.ideaText(), hook: `Revise ${cut.title} take ${take} → take ${take + 1}: ${draft.edits.length} edits`, planner: planner.id, tasks: buildReviseTasks(s.sessionId, episode, take, draft).map((t, i) => ({ ...t, taskId: `${s.sessionId}-T${i + 1}` })) });
        out(`Revision (${planner.id}): ${draft.edits.length} edits, ${draft.feedback.length} feedback points, ${draft.declined.length} declined (tokens in/out ${usage.input}/${usage.output}, cost ${costUsd === null ? "unknown" : `$${costUsd}`})`);
        if (typeof costUsd === "number" && costUsd > 0)
          room.addLedgerEntry(by, { ledger: "operations", kind: "expense", amount: costUsd, unit: "usd", status: "observed", label: `${planner.id} revise ${s.sessionId}`, evidence: s.sessionId }, "producer");
        else if (usage.input + usage.output > 0)
          room.addLedgerEntry(by, { ledger: "operations", kind: "expense", amount: usage.input + usage.output, unit: "tokens", status: "unknown", label: `${planner.id} revise ${s.sessionId} (unpriced)`, evidence: s.sessionId }, "producer");
        const inv = inventory();
        s.recordCapabilities({ reuse: [...inv.reuse, { capability: "cut.edit", source: "src/humain/cuts.ts, demo/cuts/CUT_SCHEMA.md", evidence: `validateEdits + applyEdits; ${draft.edits.length} validated edits` }], build: inv.build });
        const est = estimatePlan(plan);
        const recorded = s.recordEstimate({ ...est, forecastId: bookEstimate(room, by, s.sessionId, est) });
        out(`ESTIMATE: $${est.apiUsd} API · ${est.localHours}h local · ${est.executionSeconds}s (forecast, not a receipt)`);
        const rw = rewriteCount(draft);
        room.addLedgerEntry(by, { ledger: "effort", kind: "hours", amount: Math.round(rw * VOICE_HOURS_PER_RECORDING * 100) / 100, unit: "hours", status: "projected", label: `ESTIMATE ${s.sessionId} voice re-recordings (${rw} new)`, who: by }, "producer");
        out(`Voice cost: ${rw} new recording(s) → ${Math.round(rw * VOICE_HOURS_PER_RECORDING * 100) / 100}h estimated (booked as projected)`);
        const contract = buildReviseContract(s.sessionId, plan, cut, draft, episode, take, (t) => runAcceptance(t, s.sessionId, []));
        s.recordContract(contract, []);
        out(`Contract: desired vs observed (${contract.observed.length} facts), satisfied ${contract.satisfied.length}, modifications ${contract.modifications.length}, acceptance ${contract.acceptance.length} tests`);
        const { preserved, total } = preservedLines(cut, applyEdits(cut, draft.edits));
        out(`Reuse: ${reuseLine(draft.edits.length, preserved, total, rw)}`);
        s.approve(Number(flags.ceiling ?? 5), Number(flags.secs ?? 300));
        await executePlan(room, s, by);
        const st = s.state();
        for (const r of st.results) out(`  ${r.taskId} ${r.status} — ${r.detail}`);
        if (st.lastCheckpoint) out(`  checkpoint: ${st.lastCheckpoint.reason} — remaining: ${st.lastCheckpoint.remaining.join("; ") || "none"}`);
        if (st.accounting) {
          const a = st.accounting;
          out(`  time: human used ${a.humanUsedSecs}s of ${a.reserveMin * 60}s reserved (${a.humanReleasedSecs}s released) · autonomous ${a.autonomousSecs}s · daily budget ${a.humanBudgetMin} min`);
        }
        out(`Done: ${st.terminal?.detail} Spend $${st.spendUsd}. Replay: npm run room -- humain replay ${s.sessionId}`);
        return;
      }
      if (sub === "frames") {
        const { listFrames } = await import("./humain/frames.ts");
        const frames = listFrames();
        for (const f of frames) out(`${f.frameId} "${f.hook.slice(0, 70)}" human:${f.counts.human} unique:${f.counts.unique} verification:${f.counts.verification} sha256:${f.sha256.slice(0, 12)} /api/humain/frames/${f.frameId}`);
        const t = { human: 0, unique: 0, verification: 0 };
        for (const f of frames) {
          t.human += f.counts.human;
          t.unique += f.counts.unique;
          t.verification += f.counts.verification;
        }
        out(`totals: ${frames.length} frame(s) human:${t.human} unique:${t.unique} verification:${t.verification}`);
        return;
      }
      if (sub === "evidence") {
        const id = need(pos[1], "session id (e.g. H-0001)");
        const evs = room.store.all().filter((e) => e.type.startsWith("humain.") && (e.payload as any).sessionId === id);
        if (!evs.length) throw new RuleError("usage", `No HumAIn OS events for ${id}.`);
        const one = (t: string) => evs.filter((e) => e.type === t).at(-1)?.payload as any;
        const money = (n: number) => `$${(Math.round(n * 10000) / 10000).toFixed(4)}`;
        out(`Evidence for ${id} (observed ≠ estimated ≠ unknown; human ≠ machine):`);
        const mine = room.ledger.filter((l) => l.label.includes(id) || (l.evidence ?? "").includes(id));
        const show = (title: string, rows: typeof mine) => {
          out(`-- ${title} --`);
          if (!rows.length) out("  (none)");
          for (const l of rows) out(`  ${l.ledger}/${l.kind} ${l.amount}${l.unit === "usd" ? "" : ` ${l.unit}`} ${l.unit === "usd" ? money(l.amount) : ""} [${l.status}] ${l.label}`);
        };
        show("OBSERVED costs (receipts with evidence)", mine.filter((l) => l.status === "observed"));
        show("ESTIMATED costs (forecasts, never receipts)", mine.filter((l) => l.status === "projected"));
        show("UNKNOWN costs (usage without a price)", mine.filter((l) => l.status === "unknown" || l.status === "disputed"));
        const est = one("humain.estimate");
        if (est) out(`  contract estimate: ${money(est.apiUsd)} API · ${est.localHours}h local · ${est.executionSeconds}s [${est.label}]`);
        const a = one("humain.accounting");
        out("-- TIME --");
        if (a) {
          out(`  human: used ${a.humanUsedSecs}s of ${a.reserveMin * 60}s reserved (${a.humanReleasedSecs}s released) · daily budget ${a.humanBudgetMin} min`);
          out(`  autonomous: ${a.autonomousSecs}s execution (recorded separately)`);
        } else out("  (session has not ended; no accounting yet)");
        const caps = one("humain.capabilities");
        const contract = one("humain.contract");
        out("-- CAPABILITIES --");
        if (caps) {
          out(`  reused (${caps.reuse.length}): ${caps.reuse.map((r: any) => r.capability).join(", ") || "(none)"}`);
          out(`  newly built (${caps.build.length}): ${caps.build.map((b: any) => b.capability).join(", ") || "(none)"}`);
        }
        if (contract) {
          out(`  satisfied before execution: ${contract.satisfied.length}`);
          out(`  missing: ${contract.missing.join("; ") || "(none)"}`);
          out(`  acceptance: ${contract.acceptance.length} tests`);
        }
        const stop = one("humain.stopped");
        if (stop) out(`outcome: ${stop.reason} — ${stop.detail}`);
        return;
      }
      if (sub === "budget") {
        const { HUMAN_BUDGET_MIN } = await import("./humain/session.ts");
        const today = new Date().toISOString().slice(0, 10);
        const accts = room.store.all().filter((e) => e.type === "humain.accounting" && e.ts.startsWith(today));
        let used = 0;
        for (const e of accts) {
          const a = e.payload as { sessionId: string; humanUsedSecs: number; autonomousSecs: number };
          used += a.humanUsedSecs;
          out(`${a.sessionId}: human ${a.humanUsedSecs}s · autonomous ${a.autonomousSecs}s`);
        }
        out(`Today: human ${used}s of ${HUMAN_BUDGET_MIN * 60}s budget (${Math.round(used / 60 * 10) / 10}/${HUMAN_BUDGET_MIN} min).`);
        return;
      }
      throw new RuleError("usage", "humain demo [--idea ...] [--ceiling N] [--secs N] [--voice-file f.wav] [--live] [--reserve N] | humain revise EPISODE [--feedback ...] [--ceiling N] [--secs N] [--voice-file f.wav] [--live] | humain replay H-0001 | humain evidence H-0001 | humain frames | humain budget");
    }
    default:
      throw new RuleError("usage", `Unknown command '${cmd}'. Run \`npm run room -- help\`.`);
  }
}

main().catch((e) => {
  if (e instanceof RuleError) {
    console.error(`✗ ${e.message}  [rule: ${e.rule}]`);
    process.exit(2);
  }
  console.error(e);
  process.exit(1);
});
