// The extras: characters who keep turning up without a story of their own yet. They share
// one repo, a folder each — the same shape as a dressing room, so the character bible,
// viewer pull requests and episode projections all work on them unchanged.
//
//   future-radio-extras/
//     README.md              who's here, what they've done, and who's been promoted
//     SHOW_BIBLE.md          the shared world
//     CONTRIBUTING.md, .github/
//     yuria/                 CHARACTER.md · history/ · history.jsonl · memory/ · voice/ · bible/
//     the-cat/
//     <promoted>/PROMOTED.md a forwarding address once someone gets a dressing room
//
// When an extra catches on, `promote` splits their folder out with its git history into a
// dressing room of their own and leaves a forwarding note behind.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { initExtrasGithub } from "future-radio-character-bible";
import { addPrincipal, castFile, isPrincipal } from "../core/cast.ts";
import type { Room } from "../core/room.ts";
import { biblePackage, DressingRoom } from "./dressing-room.ts";
import { Repo, REPOS_DIR, SubRepo } from "./git.ts";

const TEMPLATE_DIR = () => process.env.CHARACTERS_DIR ?? join(process.cwd(), "characters");
const SKETCH_DIR = () => process.env.EXTRAS_DIR ?? join(process.cwd(), "seed", "extras");
const PREFIX = () => process.env.REPO_PREFIX ?? "future-radio-";

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export interface ExtraSignals {
  slug: string;
  name: string;
  appearances: string[]; // released episodes
  viewerNotes: number;
  ideas: string[]; // ideas that mention them
  votes: number; // community votes on those ideas
  openQuestions: number;
  worthConsidering: boolean;
}

export class ExtrasRepo {
  readonly repo = new Repo("extras");

  /** Clone from GitHub on a fresh deploy, otherwise open a new, empty extras repo. */
  ensure(): this {
    if (this.repo.exists) return this;
    if (this.cloneFromGithub()) return this;
    this.repo.init();
    const show = join(TEMPLATE_DIR(), "show-bible.md");
    if (existsSync(show)) this.repo.write("SHOW_BIBLE.md", readFileSync(show, "utf8"));
    initExtrasGithub(this.repo.dir, { pkg: biblePackage() });
    this.repo.write("README.md", this.readme());
    this.repo.commit("Open the extras");
    return this;
  }

  private cloneFromGithub(): boolean {
    const owner = process.env.GITHUB_OWNER;
    if (!owner || process.env.CLONE_DRESSING_ROOMS === "0" || existsSync(this.repo.dir)) return false;
    try {
      mkdirSync(dirname(this.repo.dir), { recursive: true });
      execFileSync("git", ["clone", "-q", `https://github.com/${owner}/${PREFIX()}extras`, this.repo.dir], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Every extra currently here (promoted ones have left a forwarding note instead). */
  list(): string[] {
    if (!this.repo.exists) return [];
    return readdirSync(this.repo.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(this.repo.dir, e.name, "CHARACTER.md")))
      .map((e) => e.name)
      .sort();
  }

  promoted(): Array<{ slug: string; note: string }> {
    if (!this.repo.exists) return [];
    return readdirSync(this.repo.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(this.repo.dir, e.name, "PROMOTED.md")))
      .map((e) => ({ slug: e.name, note: readFileSync(join(this.repo.dir, e.name, "PROMOTED.md"), "utf8") }));
  }

  has(slug: string) {
    return this.list().includes(slug);
  }

  /** An extra's home, usable anywhere a dressing room is. */
  extra(slug: string): DressingRoom {
    this.ensure();
    return new DressingRoom(slug, new SubRepo(`extras/${slug}`, join(this.repo.dir, slug), this.repo));
  }

  /**
   * Give someone a folder. The sketch comes from `sketch`, else seed/extras/<slug>.md, else a
   * stub that says only what we know: their name.
   */
  open(slug: string, opts: { name?: string; sketch?: string } = {}): DressingRoom {
    this.ensure();
    if (isPrincipal(slug)) throw new Error(`${slug} has a dressing room of their own.`);
    if (this.promoted().some((p) => p.slug === slug)) throw new Error(`${slug} was promoted; see ${slug}/PROMOTED.md.`);
    const home = this.extra(slug);
    if (this.has(slug)) return home;
    const seeded = join(SKETCH_DIR(), `${slug}.md`);
    const given = opts.sketch ?? (existsSync(seeded) ? readFileSync(seeded, "utf8") : null);
    // The sketch's heading names them ("# The Unspoken Orchestra — Extra"); otherwise the slug does.
    const name = opts.name ?? given?.match(/^#\s+(.+?)\s+[—–]\s+/m)?.[1]?.trim() ?? slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
    const sketch =
      given ?? `# ${name} — Extra\n\nNobody has told their story yet.\n\n## Where they've turned up\n\n## What we don't know yet\n\n- Almost everything.\n`;
    home.repo.init();
    home.repo.write("CHARACTER.md", sketch);
    home.repo.write("history.jsonl", "");
    home.repo.write("memory/notes.md", `# ${name}'s notes\n\nCanon from released episodes. Append-only.\n\n`);
    home.repo.write("memory/viewer-notes/.gitkeep", "");
    home.repo.write("voice/voice.json", JSON.stringify({ character: slug, provider: null, voice: null }, null, 2) + "\n");
    // Commit the folder with its bible first; the README index reads that bible.
    home.commitWithBible(`Open ${name}'s folder in the extras`);
    this.repo.write("README.md", this.readme());
    this.repo.amend();
    return home;
  }

  /** The names an idea or script might use for them: their name, slug and "Also called:" line. */
  names(slug: string): string[] {
    const md = this.extra(slug).repo.read("CHARACTER.md");
    const heading = md.match(/^#\s+(.+?)\s+[—–]\s+/m)?.[1];
    const also = md.match(/^Also called:\s*(.+)$/m)?.[1]?.split(",").map((s) => s.trim()) ?? [];
    return [...new Set([heading, slug.replace(/-/g, " "), ...also].filter(Boolean).map((s) => s!.toLowerCase()))];
  }

  /** Extras an idea or text mentions by any of their names. */
  mentionedIn(text: string): string[] {
    const t = text.toLowerCase();
    return this.list().filter((slug) => this.names(slug).some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)));
  }

  /** What would make a case for promotion. The producer decides; this only counts. */
  signals(slug: string, room?: Room): ExtraSignals {
    const home = this.extra(slug);
    const b = home.bible();
    const names = this.names(slug);
    const ideas = room
      ? [...room.ideas.values()].filter((i) => names.some((n) => `${i.title} ${i.question} ${i.source}`.toLowerCase().includes(n)))
      : [];
    const votes = ideas.reduce((s, i) => s + i.signals.community, 0);
    const openQuestions = (home.repo.read("CHARACTER.md").split(/^## What we don't know yet\s*$/m)[1] ?? "").split(/^## /m)[0].split("\n").filter((l) => l.startsWith("- ")).length;
    const t = castFile().promotion;
    const appearances = b.record.appearances.map((a) => a.episode ?? a.id);
    return {
      slug,
      name: b.name,
      appearances,
      viewerNotes: b.canon.viewerNotes.length,
      ideas: ideas.map((i) => i.ideaId),
      votes,
      openQuestions,
      worthConsidering: appearances.length >= t.appearances && (b.canon.viewerNotes.length >= t.viewerNotes || votes >= t.votes),
    };
  }

  /** Regenerate the README's table of who's here. */
  reindex(message = "Update the extras index"): string {
    this.repo.write("README.md", this.readme());
    return this.repo.commit(message);
  }

  readme(): string {
    const owner = process.env.GITHUB_OWNER ?? "OWNER";
    const rows = this.list().map((slug) => {
      const home = new DressingRoom(slug, new SubRepo(`extras/${slug}`, join(this.repo.dir, slug), this.repo));
      let name = slug;
      let intro = "";
      let seen = "—";
      try {
        const b = home.bible();
        name = b.name;
        intro = b.identity.intro.split("\n\n")[0].replace(/\s+/g, " ");
        seen = b.record.appearances.map((a) => a.episode).join(", ") || "—";
      } catch {
        /* folder still being set up */
      }
      return `| [${name}](${slug}/) | ${intro.replace(/\|/g, "/")} | ${seen} |`;
    });
    const promoted = this.promoted().map((p) => `- **${p.slug}** → ${p.note.match(/\((https?:[^)]+)\)/)?.[1] ?? "their own dressing room"}`);
    return `# Future Radio — the extras

Characters who keep turning up in Future Radio without a story of their own yet. Each has a
folder here with the same shape as a principal's dressing room: who they seem to be, where
they've turned up, what we don't know yet, every released appearance, and a character
bible you can talk to.

| Extra | Who they seem to be | Released in |
|---|---|---|
${rows.join("\n") || "| — | Nobody yet | |"}

## Talk to one, or tell us something

\`\`\`bash
npx github:${owner}/${PREFIX()}character-bible chat yuria
\`\`\`

Noticed something about one of them? Open a pull request with a viewer note, answer one of
their open questions, or propose a new extra — see CONTRIBUTING.md.

## Getting a dressing room

An extra is promoted when people care about them: more appearances, viewer notes, ideas
about them that people vote for. The producer decides. Promotion moves their folder,
with its full git history, into a repo of their own, and leaves a forwarding note here.
${promoted.length ? `\n## Promoted\n\n${promoted.join("\n")}\n` : ""}
Part of [Future Radio](https://github.com/${owner}/${PREFIX()}writers-room), made in public.
`;
  }

  /**
   * Give an extra a dressing room of their own. Their folder's history is split out with
   * `git subtree`, so every appearance, note and viewer contribution comes along.
   */
  promote(slug: string, reason: string): { dressingRoom: DressingRoom; extrasSha: string; carried: number } {
    if (!this.has(slug)) throw new Error(`No extra called ${slug}.`);
    if (!reason.trim()) throw new Error("A promotion records why.");
    if (this.repo.git(["status", "--porcelain"], true)) throw new Error("The extras repo has uncommitted changes; commit or sync first.");
    const target = new Repo(`dressing-room-${slug}`);
    if (existsSync(target.dir)) throw new Error(`${target.dir} already exists.`);
    const branch = `promote/${slug}`;
    this.repo.git(["subtree", "split", "-q", `--prefix=${slug}`, "-b", branch]);
    try {
      mkdirSync(dirname(target.dir), { recursive: true });
      execFileSync("git", ["clone", "-q", "-b", branch, this.repo.dir, target.dir], { stdio: ["ignore", "pipe", "pipe"] });
      target.git(["branch", "-m", branch, "main"]);
      target.git(["remote", "remove", "origin"]);
    } finally {
      this.repo.git(["branch", "-D", branch], true);
    }
    const carried = target.log(10_000).length;
    const home = new DressingRoom(slug, target);
    const name = home.bible().name;
    const owner = process.env.GITHUB_OWNER ?? "OWNER";
    target.write(
      "README.md",
      `# ${name}'s dressing room\n\nPromoted from the Future Radio extras: ${reason}\n\n` +
        `- \`CHARACTER.md\` — who ${name} is, what we know, and what we don't yet.\n` +
        `- \`history/\` — every appearance, carried over from the extras with its git history.\n` +
        `- \`memory/notes.md\` — canon from released episodes; \`memory/viewer-notes/\` — what viewers added.\n` +
        `- \`voice/voice.json\` — production voice settings.\n\n` +
        `Episode repos never edit this repo. They project from it, pinned to a commit.\n`,
    );
    home.remember(`Promoted from the extras to a dressing room of ${name.match(/^the /i) ? "its" : "their"} own: ${reason}`, "producer");
    home.refresh(`Promote ${name} from the extras`);

    // Leave a forwarding address, and register the new principal.
    rmSync(join(this.repo.dir, slug), { recursive: true, force: true });
    const url = `https://github.com/${owner}/${PREFIX()}dressing-room-${slug}`;
    this.repo.write(
      `${slug}/PROMOTED.md`,
      `# ${name} has a dressing room of their own\n\nPromoted ${new Date().toISOString().slice(0, 10)}: ${reason}\n\n→ [${PREFIX()}dressing-room-${slug}](${url})\n\nTheir history here (${carried} commits) moved with them.\n`,
    );
    const extrasSha = this.reindex(`Promote ${name} to their own dressing room`);
    addPrincipal(slug);
    return { dressingRoom: home, extrasSha, carried };
  }
}

let extras: ExtrasRepo | null = null;
let extrasRoot = "";
export function extrasRepo(): ExtrasRepo {
  if (!extras || extrasRoot !== REPOS_DIR()) {
    extras = new ExtrasRepo();
    extrasRoot = REPOS_DIR();
  }
  return extras;
}
