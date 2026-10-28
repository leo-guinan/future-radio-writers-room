// Spawn a writers' room for a creative idea: a new repo with this room's engine, the idea as
// its first season, the creative asset repos this room knows about attached, and a daily
// GitHub Action that records the morning episode. Everything is CC0, like this room.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RuleError } from "../core/room.ts";
import { castFile, ROLES, type Role } from "../core/cast.ts";
import { readAssets, type Asset } from "../daily/daily.ts";

export const ENGINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Engine files a new room doesn't inherit: this show's history and its own episodes. */
const SKIP = [/^seed\/room-log\.jsonl$/, /^seed\/episodes\//, /^seed\/extras\//, /^scenes\/cards\/(?!two-songs)/, /^proposals\/(?!README|TEMPLATE)/, /^episodes\//, /^room\//, /^GOALS\.md$/, /^assets\.json$/, /^test\//];

export interface SpawnOptions {
  idea: string;
  name: string; // repo / directory slug
  dir?: string; // where to create it; default ../<name>
  show?: string; // the show's title; default from the idea
  question?: string;
  cast?: Partial<Record<Role, string>>; // recast roles; default this room's casting
  assets?: Asset[]; // attached; default every known asset
  owner?: string; // GitHub owner, for --publish
  publish?: boolean;
  visibility?: "public" | "private";
  dailyCron?: string;
}

export interface SpawnResult {
  dir: string;
  files: number;
  assets: Asset[];
  repo?: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function trackedFiles(): string[] {
  try {
    return execFileSync("git", ["ls-files"], { cwd: ENGINE_DIR, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    throw new RuleError("spawn", "spawn copies the engine from a git checkout of the writers' room.");
  }
}

const titleFrom = (idea: string) => idea.replace(/[.?!].*$/s, "").trim().slice(0, 60) || "A new show";

export function spawnRoom(o: SpawnOptions): SpawnResult {
  if (!o.idea?.trim()) throw new RuleError("spawn", "A room needs an idea.");
  if (!SLUG.test(o.name)) throw new RuleError("spawn", `'${o.name}' isn't a repo slug (lowercase, digits, dashes).`);
  const dir = resolve(o.dir ?? join(ENGINE_DIR, "..", o.name));
  if (existsSync(dir)) throw new RuleError("spawn", `${dir} already exists.`);
  const show = o.show?.trim() || titleFrom(o.idea);
  const here = castFile();
  const roles = { ...here.roles, ...(o.cast ?? {}) } as Record<Role, string>;
  for (const r of ROLES) if (!SLUG.test(roles[r])) throw new RuleError("spawn", `The ${r} role needs a character slug.`);
  if (new Set(ROLES.map((r) => roles[r])).size !== ROLES.length) throw new RuleError("spawn", "Each role needs its own character.");
  const assets = o.assets ?? readAssets(join(ENGINE_DIR, "assets.json"));

  // 1. The engine.
  let files = 0;
  for (const f of trackedFiles()) {
    if (SKIP.some((re) => re.test(f))) continue;
    const to = join(dir, f);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(ENGINE_DIR, f), to);
    files++;
  }
  const write = (f: string, text: string) => {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  };

  // 2. Who's in it. Unknown characters get a sketch to fill in.
  write(
    "cast.json",
    JSON.stringify(
      {
        $comment: "Who plays each role. Recast by changing a slug and writing characters/<slug>.md. Models are OpenRouter ids; pick them with blind tastings (`trial run`).",
        show,
        host: here.host,
        roles,
        principals: ROLES.map((r) => roles[r]),
        models: Object.keys(here.models).length ? here.models : { default: "anthropic/claude-sonnet-5.5" },
        promotion: here.promotion,
      },
      null,
      2,
    ) + "\n",
  );
  for (const r of ROLES) {
    const f = `characters/${roles[r]}.md`;
    if (!existsSync(join(dir, f)))
      write(f, `# ${roles[r][0].toUpperCase()}${roles[r].slice(1).replace(/-/g, " ")}\n\nPlays the ${r} role in ${show}.\n\nWho they are, why they suit the role, how they get it wrong, and the line they'd never say. (Write this before the first daily episode; the room reads it as their character.)\n`);
  }

  // 3. The show.
  write(
    "characters/show-bible.md",
    `# ${show}\n\n## The idea\n\n${o.idea.trim()}\n\n## The room\n\nThis show is made in a public writers' room. ${ROLES.map((r) => `${roles[r]} plays ${r}`).join(", ")}; a showrunner assembles. Every morning the room looks over what people did since the day before and the day's goals, and records an episode about it. Nothing is canon until it's in a released episode.\n\n## What the room believes\n\n- Every claim points to a receipt.\n- Work that happened outside the room is real even when it can't be booked yet.\n- People's time is never free.\n`,
  );
  write(
    "seed/season-1.json",
    JSON.stringify(
      {
        source: `${show}: the idea, ${new Date().toISOString().slice(0, 10)}`,
        ts: new Date().toISOString(),
        episodes: [{ episodeId: "E01", number: 1, title: "Pilot", logline: o.idea.trim().slice(0, 300), canonical: true, budget: { cashCeiling: 20, runtimeMinutes: [5, 10] } }],
        scenes: [],
        ideas: [{ title: show, question: o.question?.trim() || `What does "${titleFrom(o.idea)}" become when people help make it?`, output: "episode", episodeId: "E01", status: "proposed" }],
        forecasts: [],
      },
      null,
      2,
    ) + "\n",
  );
  write("assets.json", JSON.stringify({ $comment: "Creative asset repos attached to this room. The daily episode reads what people changed in each since yesterday.", assets }, null, 2) + "\n");
  write(
    "GOALS.md",
    `# Production goals\n\nThe daily episode reads today's section (\`## YYYY-MM-DD\`) and the standing goals.\n\n## Standing\n\n- Answer what came in from people before starting anything new.\n- Keep every claim tied to a receipt.\n\n## ${new Date().toISOString().slice(0, 10)}\n\n- Read the idea and say what the pilot could be.\n`,
  );
  write("ROOM.md", `# ${show}\n\nSpawned from [future-radio-writers-room](https://github.com/leo-guinan/future-radio-writers-room) on ${new Date().toISOString().slice(0, 10)}.\n\n## The idea\n\n${o.idea.trim()}\n\n## Attached creative assets\n\n${assets.length ? assets.map((a) => `- [${a.repo}](https://github.com/${a.repo})${a.about ? ` — ${a.about}` : ""}`).join("\n") : "- None yet: \`npm run room -- assets add owner/repo\`."}\n`);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkg.name = o.name;
  // The engine's tests are about Future Radio's season; they stay upstream.
  pkg.scripts = { ...pkg.scripts, test: 'echo "The engine is tested upstream in future-radio-writers-room."' };
  pkg.description = `${show}: a public writers' room. ${o.idea.trim().slice(0, 140)}`;
  write("package.json", JSON.stringify(pkg, null, 2) + "\n");
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  write("README.md", `# ${show}\n\n${o.idea.trim()}\n\nA public writers' room spawned from Future Radio's. See [ROOM.md](ROOM.md) for the idea and attached assets, [GOALS.md](GOALS.md) for today's goals, and \`episodes/daily/\` for the morning episodes.\n\n## Every morning\n\nA GitHub Action (\`.github/workflows/daily.yml\`) collects what people changed since yesterday in this repo and every attached asset repo, reads today's goals, and has the room play an episode about it. Add an \`OPENROUTER_API_KEY\` secret to the repo for the characters' own lines; without it they run offline.\n\n---\n\n${readme.replace(/^# .*\n/, "")}`);
  write(".github/workflows/daily.yml", dailyWorkflow({ mode: "local", cron: o.dailyCron }));

  // 4. History of its own.
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g(["init", "--quiet", "-b", "main"]);
  g(["add", "-A"]);
  g(["-c", "user.name=Writers' room", "-c", "user.email=writers-room@users.noreply.github.com", "commit", "--quiet", "-m", `Spawn ${show}\n\n${o.idea.trim()}`]);

  let repo: string | undefined;
  if (o.publish) {
    if (!o.owner) throw new RuleError("spawn", "--publish needs --owner.");
    repo = `${o.owner}/${o.name}`;
    execFileSync("gh", ["repo", "create", repo, `--${o.visibility ?? "public"}`, "--source", dir, "--push", "--description", pkg.description.slice(0, 340)], { stdio: "inherit" });
  }
  return { dir: relative(process.cwd(), dir) || ".", files, assets, repo };
}

/**
 * The daily Action. "local": the room lives in the repo (its log in room/), so the Action runs
 * it and commits the episode. "remote": the room runs on a server; the Action collects what came
 * in, asks the live room to record the episode through the producer console, and commits the
 * transcript. Remote needs a ROOM_URL variable and a PRODUCER_TOKEN secret; without them it
 * says so and stops.
 */
export function dailyWorkflow({ mode, cron = "17 11 * * *" }: { mode: "local" | "remote"; cron?: string }): string {
  return `# The morning episode: what people did since yesterday, today's goals, and the room talking it over.
name: Daily episode
on:
  schedule:
    - cron: "${cron}" # UTC
  workflow_dispatch:
    inputs:
      day:
        description: "Record for this day (YYYY-MM-DD); default today"
        required: false
permissions:
  contents: write
concurrency: daily-episode
jobs:
  daily:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      ROOM_MODE: ${mode}
      ROOM_URL: \${{ vars.ROOM_URL }}
      PRODUCER_TOKEN: \${{ secrets.PRODUCER_TOKEN }}
      OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}
      DATA_DIR: room
      REPOS_DISABLED: "1"
      DAY: \${{ inputs.day }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Record today's episode
        env:
          ASSET_CACHE: \${{ runner.temp }}/assets
        run: node scripts/daily-action.mjs
      - name: Commit the episode
        run: |
          git add -A room episodes 2>/dev/null || true
          if git diff --cached --quiet; then echo "Nothing to commit."; exit 0; fi
          git -c user.name="Writers' room" -c user.email="writers-room@users.noreply.github.com" commit -m "Daily episode \${DAY:-$(date -u +%F)}"
          git push
`;
}
