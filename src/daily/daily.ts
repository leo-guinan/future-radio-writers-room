// The daily episode. Each morning the room looks over what came in from humans since the day
// before (commits to the room and to every attached asset repo, ideas, votes, notes, tasting
// feedback) and the day's production goals, and plays a scene about it.
//
// The first time, the characters can hardly believe they can see any of it. By the end of the
// season it's ordinary. The arc is set by how many daily episodes there have been: the phase
// changes the situation and each role's motivation, never the facts in front of them.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Room } from "../core/room.ts";
import { RuleError } from "../core/room.ts";
import { DATA_DIR } from "../core/open.ts";
import { playedBy, principals, ROLES, type Role } from "../core/cast.ts";
import type { LLM } from "../agents/llm.ts";
import { openScene, runScene, sceneMarkdown } from "../scenes/scenes.ts";

export interface Asset {
  repo: string; // owner/name
  kind?: string;
  about?: string;
}

export interface Change {
  repo: string;
  sha: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
}

export interface Digest {
  day: string; // YYYY-MM-DD the episode is for
  since: string; // ISO time the window opens
  commits: Change[];
  goals: string[];
  /** Repos that couldn't be read, and why. */
  unreachable?: Array<{ repo: string; error: string }>;
}

export const assetsFile = () => process.env.ASSETS_FILE ?? join(process.cwd(), "assets.json");
export const goalsFile = () => process.env.GOALS_FILE ?? join(process.cwd(), "GOALS.md");
export const dailyDir = () => process.env.DAILY_DIR ?? join(process.cwd(), "episodes", "daily");
export const seasonLength = () => Number(process.env.DAILY_SEASON ?? 8);

export function readAssets(path = assetsFile()): Asset[] {
  if (!existsSync(path)) return [];
  const f = JSON.parse(readFileSync(path, "utf8"));
  return (Array.isArray(f) ? f : f.assets ?? []).filter((a: Asset) => /^[\w.-]+\/[\w.-]+$/.test(a.repo));
}

export function writeAssets(assets: Asset[], path = assetsFile()) {
  const f = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  writeFileSync(path, JSON.stringify({ ...(Array.isArray(f) ? {} : f), assets }, null, 2) + "\n");
}

/** Today's goals: the `## YYYY-MM-DD` section of GOALS.md plus the standing ones. */
export function goalsFor(day: string, path = goalsFile()): string[] {
  if (!existsSync(path)) return [];
  const out: string[] = [];
  let take = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      take = h[1] === day || /^standing|^every day/i.test(h[1]);
      continue;
    }
    const b = /^\s*[-*]\s+(.+)$/.exec(line);
    if (take && b) out.push(b[1].trim());
  }
  return out;
}

// Characters' and bots' commits aren't "what came in from humans".
const AGENT_AUTHOR = /\[bot\]|github-actions|noreply@anthropic|^writers?[- ]room|^showrunner$/i;
const AGENT_SUBJECT = /^R-[A-Z][a-z0-9]+\b|^Daily episode|^Rebuild bible|^Show plan for|^First cut/;

const git = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 << 20 });

/** Human commits in one checkout since a time. */
export function commitsIn(dir: string, repo: string, since: string): Change[] {
  const SEP = "\u001f";
  const out = git(["log", `--since=${since}`, "--no-merges", `--pretty=format:%x1e%H${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s`, "--name-only"], dir);
  const names = new Set(principals().map((p) => p.toLowerCase()));
  return out
    .split("\u001e")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [head, ...files] = block.split("\n");
      const [sha, author, email, date, subject] = head.split(SEP);
      return { repo, sha, author, email, date, subject, files: files.map((f) => f.trim()).filter(Boolean) };
    })
    .filter((c) => !AGENT_AUTHOR.test(c.author) && !AGENT_AUTHOR.test(c.email) && !names.has(c.author.toLowerCase()) && !AGENT_SUBJECT.test(c.subject))
    .map(({ email: _e, ...c }) => c);
}

/** Clone or update an asset repo into the cache, then read its human commits. */
export function assetCommits(asset: Asset, since: string): Change[] {
  const dir = join(process.env.ASSET_CACHE ?? join(DATA_DIR, "assets"), asset.repo.replace("/", "__"));
  const url = process.env.ASSET_GIT_BASE ? `${process.env.ASSET_GIT_BASE}/${asset.repo}` : `https://github.com/${asset.repo}.git`;
  if (existsSync(join(dir, ".git"))) git(["fetch", "--quiet", "origin"], dir), git(["reset", "--quiet", "--hard", "FETCH_HEAD"], dir);
  else mkdirSync(dir, { recursive: true }), git(["clone", "--quiet", "--filter=blob:none", "--no-checkout", url, dir]);
  return commitsIn(dir, asset.repo, since);
}

/** Everything that came in since `since`, from the room's own repo and its assets. */
export function collect(opts: { day: string; since: string; assets?: Asset[]; roomRepo?: { dir: string; name: string } | null }): Digest {
  const commits: Change[] = [];
  const unreachable: Digest["unreachable"] = [];
  if (opts.roomRepo && existsSync(join(opts.roomRepo.dir, ".git"))) {
    try {
      commits.push(...commitsIn(opts.roomRepo.dir, opts.roomRepo.name, opts.since));
    } catch (e) {
      unreachable.push({ repo: opts.roomRepo.name, error: (e as Error).message.split("\n")[0] });
    }
  }
  for (const a of opts.assets ?? readAssets()) {
    try {
      commits.push(...assetCommits(a, opts.since));
    } catch (e) {
      unreachable.push({ repo: a.repo, error: (e as Error).message.split("\n")[0] });
    }
  }
  commits.sort((a, b) => a.date.localeCompare(b.date));
  return { day: opts.day, since: opts.since, commits, goals: goalsFor(opts.day), ...(unreachable.length ? { unreachable } : {}) };
}

/** What people did in the room itself since `since`: ideas, votes, notes, tastings. */
export function roomArrivals(room: Room, since: string): string[] {
  const out: string[] = [];
  for (const e of room.publicEvents()) {
    if (e.ts < since) continue;
    const p = e.payload as any;
    const who = e.actor.replace(/^patron:/, "");
    if (e.type === "idea.proposed") out.push(`${who} proposed ${p.ideaId} "${p.title}"`);
    else if (e.type === "idea.signal" && p.kind === "community") out.push(`someone voted for ${p.ideaId}`);
    else if (e.type === "idea.signal") out.push(`${who} gave ${p.ideaId} a ${p.kind} signal`);
    else if (e.type === "idea.note") out.push(`${who} noted on ${p.ideaId}: ${String(p.text).slice(0, 140)}`);
    else if (e.type === "trial.feedback") out.push(`${who} tasted ${p.trialId} blind and liked version ${p.favorite}${p.note ? `: "${String(p.note).slice(0, 140)}"` : ""}`);
    else if (e.type === "ledger.entry" && p.kind === "hours") out.push(`${p.who ?? who} logged ${p.amount} hours: ${p.label}`);
  }
  return out;
}

// ---------------------------------------------------------------- the arc

export type Phase = "astonished" | "testing" | "relying" | "commonplace";

export function phaseFor(number: number, total = seasonLength()): Phase {
  const f = total <= 1 ? 1 : (number - 1) / (total - 1);
  return f < 0.15 ? "astonished" : f < 0.45 ? "testing" : f < 0.8 ? "relying" : "commonplace";
}

const ARC: Record<Phase, { situation: string; motivations: Record<Role, string> }> = {
  astonished: {
    situation:
      "This is the first morning the room can see what the humans did while it wasn't running. Until now the characters only knew what happened inside the room. They don't yet trust that this is real, or that it will happen again.",
    motivations: {
      memory: "You can see work that happened outside the room, and you want to hold every piece of it. Check each thing against its receipt (the commit, the event) before you believe it, and let yourself be amazed when it holds.",
      making: "Every item that came in is a door you didn't know existed. You can barely stand still. Get the room to make something today out of the most surprising one.",
      accounting: "Until today you could only count what happened in the room. Now you can see humans' work from outside it. Work out what it's worth and whether you're allowed to book it, and say plainly what you can't book yet.",
    },
  },
  testing: {
    situation:
      "It happened again: overnight, what the humans did is waiting for the room. The characters are starting to believe it but still check whether it's complete, whether anything is missing, and what they're not seeing.",
    motivations: {
      memory: "Compare today's arrivals with yesterday's. Find the pattern, and the gap: what you'd expect to see that isn't there.",
      making: "Test the new sense: propose something that only works if the overnight view is reliable, and see if the others will bet on it.",
      accounting: "Measure it. How much came in, from whom, and what did it cost them? Start a running count you can defend.",
    },
  },
  relying: {
    situation:
      "The overnight view is part of how the room works now. The characters plan the day around it and get impatient when something is missing from it.",
    motivations: {
      memory: "Connect today's arrivals to the room's longer record. Remind the others what this continues, and what it quietly contradicts.",
      making: "Turn what came in straight into today's plan. Don't admire it; use it.",
      accounting: "Hold today's work to the goals. Name what moves a goal and what doesn't, and what it will cost.",
    },
  },
  commonplace: {
    situation:
      "Of course the humans' work is there in the morning; it always is. The characters barely remark on it. Only what is genuinely new, or missing, gets their attention.",
    motivations: {
      memory: "Skip what's routine. Point only at what is new, and what has quietly stopped arriving.",
      making: "Get to the work. One idea, today's, from what came in.",
      accounting: "Be brief: what changed in the numbers, what the goals need, what you can't book.",
    },
  },
};

/** A digest as the card's situation: counts, then the items themselves, kept short. */
export function digestText(d: Digest, arrivals: string[], limit = 3500): string {
  const byRepo = new Map<string, Change[]>();
  for (const c of d.commits) byRepo.set(c.repo, [...(byRepo.get(c.repo) ?? []), c]);
  const lines: string[] = [];
  lines.push(`Since ${d.since.slice(0, 16).replace("T", " ")} UTC: ${d.commits.length} commit${d.commits.length === 1 ? "" : "s"} by people across ${byRepo.size} repo${byRepo.size === 1 ? "" : "s"}, and ${arrivals.length} thing${arrivals.length === 1 ? "" : "s"} in the room itself.`);
  for (const [repo, cs] of byRepo) {
    lines.push(`In ${repo}:`);
    for (const c of cs) lines.push(`- ${c.author}: ${c.subject}${c.files.length ? ` (${c.files.slice(0, 4).join(", ")}${c.files.length > 4 ? `, +${c.files.length - 4}` : ""})` : ""} [${c.sha.slice(0, 7)}]`);
  }
  if (arrivals.length) lines.push("In the room:", ...arrivals.map((a) => `- ${a}`));
  if (d.unreachable?.length) lines.push(`Couldn't read: ${d.unreachable.map((u) => u.repo).join(", ")}.`);
  let text = lines.join("\n");
  if (text.length > limit) text = `${text.slice(0, limit)}\n… and more (see the episode file).`;
  return text;
}

export interface DailyResult {
  sceneId: string;
  number: number;
  phase: Phase;
  file: string | null;
  markdown: string;
}

/** Play and save today's episode. */
export async function recordDaily(ctx: { room: Room; llm: LLM; askedBy: string }, d: Digest, opts: { write?: boolean } = {}): Promise<DailyResult> {
  const { room } = ctx;
  if (room.dailies.some((x) => x.day === d.day)) throw new RuleError("daily", `There's already a daily episode for ${d.day}.`);
  const number = room.dailies.length + 1;
  const phase = phaseFor(number);
  const arrivals = roomArrivals(room, d.since);
  const quiet = !d.commits.length && !arrivals.length;
  const arc = ARC[phase];
  const goals = d.goals.length ? d.goals.map((g) => `- ${g}`).join("\n") : "(no goals were written down for today)";
  const s = openScene(
    ctx,
    {
      title: `Daily ${number}: ${d.day}`,
      setting: "The writers' room, first thing in the morning. On the screen: everything people did since yesterday.",
      situation: `${arc.situation}${quiet ? " This morning, nothing came in at all." : ""}\n\nWhat came in:\n${digestText(d, arrivals)}\n\nToday's production goals:\n${goals}`,
      stakes: quiet ? "Whether a quiet night means people have stopped, or just slept." : "What the room makes of the humans' work today, and whether it serves the goals.",
      stoppingRule: "They have agreed what today's work is and what they'll say back to the people whose work came in.",
      maxTurns: Number(process.env.DAILY_MAX_TURNS ?? 12),
    },
    ROLES.map((r) => ({ character: playedBy(r), motivation: arc.motivations[r] })),
  );
  const done = await runScene(ctx, s.sceneId);
  const appendix = [
    "",
    "## What came in",
    "",
    ...(d.commits.length ? d.commits.map((c) => `- \`${c.repo}@${c.sha.slice(0, 7)}\` ${c.author}: ${c.subject}`) : ["- No commits from people."]),
    ...arrivals.map((a) => `- ${a}`),
    ...(d.unreachable?.length ? ["", `Couldn't read: ${d.unreachable.map((u) => `${u.repo} (${u.error})`).join("; ")}`] : []),
    "",
    "## Today's goals",
    "",
    ...(d.goals.length ? d.goals.map((g) => `- ${g}`) : ["- None written down."]),
    "",
    `_Daily episode ${number} of ${seasonLength()} (${phase}). Window opened ${d.since}._`,
    "",
  ].join("\n");
  const markdown = sceneMarkdown(done, done.closed?.reason) + appendix;
  let file: string | null = null;
  if (opts.write !== false) {
    mkdirSync(dailyDir(), { recursive: true });
    file = join(dailyDir(), `${d.day}.md`);
    writeFileSync(file, markdown);
  }
  room.recordDaily(ctx.askedBy, {
    day: d.day,
    number,
    phase,
    sceneId: s.sceneId,
    changes: d.commits.length + arrivals.length,
    goals: d.goals.length,
    ...(file ? { file: file.replace(`${process.cwd()}/`, "") } : {}),
  });
  return { sceneId: s.sceneId, number, phase, file, markdown };
}

/** Yesterday at this time, as the default window. */
export const defaultSince = (now = new Date()) => new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
export const today = (now = new Date()) => now.toISOString().slice(0, 10);
