// An episode repo starts empty except for the show plan. Everything else arrives by
// projection — a pinned, cited copy of what the episode needs from a dressing room —
// or by the showrunner assembling cuts.
//
//   SHOW_PLAN.md        the plan: logline, runtime, ceiling, deadline, locked rules
//   gates.json          this episode's quality gates (copied from the room default)
//   cast/<char>.md      projections from dressing rooms, pinned to a commit
//   cuts/<idea>/        first cuts: CARD.md, BEATS.md, SCRIPT.md
//   GATES.md            the latest gate report: what passed, what was held, and why
//   PROVENANCE.json     every projected file → source repo, commit, paths, sha256

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../core/events.ts";
import type { Episode } from "../core/room.ts";
import { LOCKED_RULES } from "../core/room.ts";
import type { Character } from "../core/types.ts";
import { dressingRoom } from "./dressing-room.ts";
import { Repo } from "./git.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** On a fresh deploy, an episode repo that is already on GitHub is cloned, not recreated. */
function cloneFromGithub(name: string, dir: string): boolean {
  const owner = process.env.GITHUB_OWNER;
  if (!owner || process.env.CLONE_DRESSING_ROOMS === "0" || existsSync(dir)) return false;
  try {
    mkdirSync(dirname(dir), { recursive: true });
    execFileSync("git", ["clone", "-q", `https://github.com/${owner}/${process.env.REPO_PREFIX ?? "future-radio-"}${name}`, dir], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return true;
  } catch {
    return false;
  }
}

export interface Projection {
  character: Character;
  file: string;
  repo: string;
  sha: string;
  sources: string[];
}

interface Provenance {
  files: Record<string, { repo: string; sha: string; sources: string[]; sha256: string; projectedAt: string }>;
}

export const episodeRepoName = (episodeId: string) => `episode-${episodeId.toLowerCase()}`;

export class EpisodeRepo {
  readonly repo: Repo;
  constructor(readonly episodeId: string) {
    this.repo = new Repo(episodeRepoName(episodeId));
  }

  /** Create the repo with nothing but the show plan and the gates. */
  ensure(ep: Episode): { created: boolean; sha: string } {
    if (this.repo.exists && this.repo.has("SHOW_PLAN.md")) return { created: false, sha: this.repo.head() };
    if (cloneFromGithub(this.repo.name, this.repo.dir) && this.repo.has("SHOW_PLAN.md")) return { created: false, sha: this.repo.head() };
    this.repo.init();
    this.repo.write("SHOW_PLAN.md", showPlan(ep));
    const gates = readFileSync(process.env.GATES_FILE ?? join(process.cwd(), "gates.json"), "utf8");
    this.repo.write("gates.json", gates);
    return { created: true, sha: this.repo.commit(`Show plan for ${ep.episodeId}: ${ep.title}`) };
  }

  gates(): any {
    return JSON.parse(this.repo.read("gates.json"));
  }

  provenance(): Provenance {
    return this.repo.has("PROVENANCE.json") ? JSON.parse(this.repo.read("PROVENANCE.json")) : { files: {} };
  }

  /**
   * Project a character into the episode: their persona, their notes, and the history
   * entries most relevant to `query` — each cited to the dressing room commit it came from.
   */
  project(character: Character, query: string, ideaId?: string): Projection {
    const room = dressingRoom(character).ensure();
    const sha = room.repo.head();
    const short = sha.slice(0, 7);
    const repoName = room.repo.name;
    const relevant = room.relevant(query, 5, ideaId);
    const bible = room.bible();
    const notes = [
      ...bible.canon.notes.slice(-8).map((n) => `- ${n}`),
      ...bible.canon.viewerNotes.slice(-8).map((v) => `- ${v.note.split("\n")[0]} — _viewer note from ${v.from}_ (\`${repoName}@${short}:${v.file}\`)`),
    ];
    const voice = bible.voice.samples.slice(-4);
    const sources = ["CHARACTER.md", "bible/bible.json", ...(notes.length ? ["memory/notes.md"] : []), ...bible.canon.viewerNotes.map((v) => v.file), ...relevant.map((r) => r.file)];
    const name = character[0].toUpperCase() + character.slice(1);
    const content =
      `<!-- projected from ${repoName}@${sha} — do not edit; re-project instead -->\n` +
      `# ${name} in ${this.episodeId}\n\n` +
      `Projected from \`${repoName}@${short}\`.\n\n` +
      `## Who they are\n\n${stripTitle(room.repo.showAt(sha, "CHARACTER.md"))}\n\n` +
      (notes.length ? `## Canon they carry\n\n${notes.join("\n")}\n\n` : "") +
      (voice.length ? `## How they sound\n\n${voice.map((v) => `> ${v.line}\n> — \`${repoName}@${short}:${v.source}\``).join("\n\n")}\n\n` : "") +
      `## What they've already said that bears on this\n\n` +
      (relevant.length
        ? relevant.map((r) => `- ${oneLine(r.text)} — \`${repoName}@${short}:${r.file}\` (room ${r.eventId})`).join("\n")
        : "_Nothing yet. This is their first time near this idea._") +
      "\n";
    const file = `cast/${character}.md`;
    this.repo.write(file, content);
    const prov = this.provenance();
    prov.files[file] = { repo: repoName, sha, sources, sha256: sha256(content), projectedAt: new Date().toISOString() };
    this.repo.write("PROVENANCE.json", JSON.stringify(prov, null, 2) + "\n");
    return { character, file, repo: repoName, sha, sources };
  }

  writeCut(ideaId: string, files: Record<string, string>): string[] {
    const written: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const rel = `cuts/${ideaId}/${name}`;
      this.repo.write(rel, content);
      written.push(rel);
    }
    return written;
  }

  hasCut(ideaId: string) {
    return this.repo.exists && this.repo.has(`cuts/${ideaId}/CARD.md`);
  }
}

function showPlan(ep: Episode): string {
  return `# ${ep.episodeId} — ${ep.title}

${ep.logline}

| | |
|---|---|
| Episode | ${ep.number}${ep.canonical ? " (canonical)" : ""} |
| Runtime | ${ep.budget.runtimeMinutes[0]}–${ep.budget.runtimeMinutes[1]} minutes, audio first |
| Cash ceiling | $${ep.ceiling.toFixed(2)} (raising it needs a recorded authorization) |
| Deadline | ${ep.deadline ?? "—"} |
| Round | ${ep.round ?? "—"} |

## The test for every scene

Does it advance the story, explain the business, or invite participation? The best do two or three.

## Locked rules

${LOCKED_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n")}

## How this repo fills up

This repo began with only this plan. The showrunner adds projections of the cast from
their dressing rooms (\`cast/\`), and first cuts of ideas that pass the quality gates
(\`cuts/\`). \`GATES.md\` explains every idea held back. A first cut is a draft for
comparison; the producer selects what becomes the episode.
`;
}

const stripTitle = (md: string) => md.replace(/^# .*\n+/, "").trim();
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 240);
