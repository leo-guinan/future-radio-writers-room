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
