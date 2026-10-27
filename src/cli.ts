// The producer's console. Every command writes to the same log the workshop reads.
//
//   npm run room -- <command> [args] [--flags]
//
// Run `npm run room -- help` for the full list.

import { openRoom, LOG_PATH } from "./core/open.ts";
import { RuleError } from "./core/room.ts";
import { EPISODE_STAGES, IDEA_EXITS, IDEA_STAGES, type Character, type EpisodeStage, type IdeaStatus, type LedgerEntry, type OutputKind, type SignalKind } from "./core/types.ts";
import { makeLLM } from "./agents/llm.ts";
import { ask, explore } from "./agents/characters.ts";
import { account, checklist, fileSha, LOOP, nextStep } from "./production/loop.ts";
import { seed } from "./seed.ts";
import { tick } from "./showrunner/showrunner.ts";
import { dressingRoom } from "./repos/dressing-room.ts";
import { EpisodeRepo } from "./repos/episode-repo.ts";
import { localRepos, planPublish, publish } from "./repos/publish.ts";
import { REPOS_DIR } from "./repos/git.ts";
import { CAST } from "./core/types.ts";

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
  seed                                   Seed an empty room from seed/season-1.json
  verify                                 Check the hash chain of the event log
  serve                                  Start the workshop server (same as npm start)

Season & episodes
  status [EP]                            Season overview, or one episode's checklist and next step
  episode advance EP <stage> [--note]    Move to the next stage: ${EPISODE_STAGES.slice(1).join(" → ")}
  episode select EP SCENE yes|no --reason "..."
  episode asset EP <kind> <label> <path|url> [--private]   kind: script|audio|music|sfx|art|notes|other
  episode release EP <file> --invitation "..." [--version v1] [--script file] [--runtime min]
  episode account EP --hours N --learned "..." [--cash USD --evidence ref] [--revisions N] [--who name]
  budget EP <new-ceiling> --reason "..."

Ideas
  idea add --title ... --question ... --source ... [--output scene] [--episode EP] [--by name]
  idea move ID <${[...IDEA_STAGES, ...IDEA_EXITS].join("|")}> --reason "..." [--result ...] [--capability ...] [--merged-into ID] [--cash N --hours N]
  signal ID creative|community|financial <value> [--receipt ref] [--note ...]
  board                                  Ideas with their three separate signals

The characters
  explore ID                             Borges remembers → Leonardo creates → Agnolo evaluates
  ask borges|leonardo|agnolo "..." [--idea ID] [--public]

Showrunner & repos
  showrunner tick EP [--no-explore] [--assigned-only]   Explore, gate, and assemble first cuts into the episode repo
  showrunner gates EP                    Active gates and why each open candidate is held
  remember borges|leonardo|agnolo "note" [--source ref]  Add a durable note to a dressing room
  repos list                             Dressing rooms and episode repos, with heads
  repos publish --owner GH_OWNER [--public] [--yes]   Create/push GitHub repos (dry run without --yes)

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
      const n = seed(room, PRODUCER);
      return out(`Seeded ${n} events into ${LOG_PATH}. Episode 10 is at 'select' with ${[...room.mustEpisode("E10").scenes.values()].filter((s) => s.selected).length} scenes selected.`);
    }
    case "verify":
      return out(room.store.verify());

    case "status": {
      if (pos[0]) {
        const ep = room.mustEpisode(pos[0]);
        const next = nextStep(room, ep.episodeId);
        out(`${ep.episodeId} "${ep.title}" — stage: ${ep.stage} · cash $${room.episodeCash(ep.episodeId).toFixed(2)} / $${ep.ceiling.toFixed(2)} · hours ${room.episodeHours(ep.episodeId)}`);
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
        let hash: string | undefined;
        try { hash = fileSha(uri); } catch { hash = undefined; }
        return out(room.addAsset(by, { episodeId: epId, kind: need(pos[2], "kind") as any, label: need(pos[3], "label"), uri, sha256: hash }, flags.private ? "producer" : "public").id);
      }
      if (sub === "release") {
        const file = need(pos[2], "released file");
        const ev = room.release(by, {
          episodeId: epId,
          version: flags.version ?? `v${room.mustEpisode(epId).releases.length + 1}`,
          uri: flags.uri ?? file,
          sha256: fileSha(file),
          scriptSha256: flags.script ? fileSha(flags.script) : undefined,
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
            hours: Number(need(flags.hours, "--hours")),
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
      const c = need(pos[0], "character") as Character;
      if (!CAST.includes(c)) throw new RuleError("usage", `Characters: ${CAST.join(", ")}`);
      return out(dressingRoom(c).remember(need(pos[1], "note"), flags.source ?? by));
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
        for (const r of publish(steps)) out(`${r.ok ? "✓" : "✗"} ${r.action} ${r.target}${r.ok ? "" : ` — ${r.error}`}`);
        return;
      }
      throw new RuleError("usage", "repos list | repos publish --owner X [--public] [--yes]");
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
