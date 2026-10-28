// Publishing to GitHub is explicit. `planPublish` says what would happen; `publish`
// does it with the GitHub CLI (`gh`), creating private repos unless told otherwise.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Repo, REPOS_DIR } from "./git.ts";

export const PREFIX = process.env.REPO_PREFIX ?? "future-radio-";

export const BIBLE_TOOL_DIR = () => process.env.CHARACTER_BIBLE_DIR ?? join(process.cwd(), "..", "future-radio-character-bible");

/** The tool repo first (the dressing rooms' CI runs it), then dressing rooms and episodes. */
export function localRepos(): Repo[] {
  const dir = REPOS_DIR();
  const tool = existsSync(join(BIBLE_TOOL_DIR(), ".git")) ? [new Repo("future-radio-character-bible", BIBLE_TOOL_DIR())] : [];
  if (!existsSync(dir)) return tool;
  return [
    ...tool,
    ...readdirSync(dir)
      .filter((n) => existsSync(join(dir, n, ".git")))
      .sort()
      .map((n) => new Repo(n)),
  ];
}

export interface PublishStep {
  repo: string;
  target: string;
  action: "create" | "push";
  command: string[];
}

export function planPublish(owner: string, visibility: "private" | "public" = "private"): PublishStep[] {
  return localRepos().map((r) => {
    const target = `${owner}/${r.name.startsWith(PREFIX) ? r.name : PREFIX + r.name}`;
    // The bible tool holds no show content and other repos' CI must be able to fetch it: always public.
    const vis = r.name.endsWith("character-bible") ? "public" : visibility;
    return r.remote()
      ? { repo: r.name, target: r.remote(), action: "push" as const, command: ["git", "-C", r.dir, "push", "-u", "origin", "main"] }
      : { repo: r.name, target, action: "create" as const, command: ["gh", "repo", "create", target, `--${vis}`, "--source", r.dir, "--remote", "origin", "--push"] };
  });
}

export function publish(steps: PublishStep[]) {
  return steps.map((s) => {
    try {
      execFileSync(s.command[0], s.command.slice(1), { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      return { ...s, ok: true as const };
    } catch (e: any) {
      return { ...s, ok: false as const, error: String(e.stderr || e.message).trim().split("\n").at(-1) };
    }
  });
}
