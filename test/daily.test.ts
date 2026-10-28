import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/core/events.ts";
import { Room } from "../src/core/room.ts";
import { seed } from "../src/seed.ts";
import { OfflineLLM } from "../src/agents/llm.ts";
import { collect, goalsFor, phaseFor, recordDaily } from "../src/daily/daily.ts";
import { ENGINE_DIR, spawnRoom } from "../src/spawn/spawn.ts";

let dir: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A repo with one human commit, one character commit and one bot commit, all recent. */
function fakeAsset(base: string, repo: string) {
  const d = join(base, repo);
  mkdirSync(d, { recursive: true });
  git(d, "init", "--quiet", "-b", "main");
  const commit = (name: string, email: string, file: string, msg: string) => {
    writeFileSync(join(d, file), `${msg}\n`);
    git(d, "add", "-A");
    git(d, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--quiet", "-m", msg);
  };
  commit("Ada Patron", "ada@example.com", "notes.md", "A note on Leonardo's lute");
  commit("borges", "borges@future.radio", "run-R-B1.json", "R-Babc123");
  commit("github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com", "bible.md", "Rebuild bible");
  return d;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fr-daily-"));
  process.env.REPOS_DISABLED = "1";
  process.env.ASSET_CACHE = join(dir, "cache");
  process.env.ASSET_GIT_BASE = `file://${join(dir, "remotes")}`;
  process.env.GOALS_FILE = join(dir, "GOALS.md");
  process.env.DAILY_DIR = join(dir, "daily");
  writeFileSync(process.env.GOALS_FILE, "# Goals\n\n## Standing\n\n- Answer people first.\n\n## 2026-10-29\n\n- Pick the song.\n\n## 2026-10-30\n\n- Not today.\n");
});

test("goals: today's section plus the standing ones", () => {
  assert.deepEqual(goalsFor("2026-10-29"), ["Answer people first.", "Pick the song."]);
  assert.deepEqual(goalsFor("2026-11-01"), ["Answer people first."]);
});

test("collect keeps people's commits and leaves out the characters' and the bots'", () => {
  fakeAsset(join(dir, "remotes"), "leo/songs");
  const d = collect({ day: "2026-10-29", since: new Date(Date.now() - 3600_000).toISOString(), assets: [{ repo: "leo/songs" }, { repo: "leo/missing" }], roomRepo: null });
  assert.equal(d.commits.length, 1);
  assert.equal(d.commits[0].author, "Ada Patron");
  assert.deepEqual(d.commits[0].files, ["notes.md"]);
  assert.equal(d.unreachable?.[0].repo, "leo/missing");
  assert.deepEqual(d.goals, ["Answer people first.", "Pick the song."]);
});

test("the arc runs from astonished to commonplace", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => phaseFor(n, 8)), ["astonished", "astonished", "testing", "testing", "relying", "relying", "commonplace", "commonplace"]);
});

test("a daily episode is played, saved and recorded once per day", async () => {
  const room = new Room(new EventStore(null));
  seed(room);
  room.proposeIdea("patron:cy", { title: "A song for the cat", question: "Does the cat sing?", source: "Episode 1", output: "song", contributor: { name: "cy", credit: true, reuse: "cc-by" } });
  const digest = { day: "2026-10-29", since: new Date(Date.now() - 3600_000).toISOString(), commits: [{ repo: "leo/songs", sha: "abcdef1234", author: "Ada Patron", date: new Date().toISOString(), subject: "A note on Leonardo's lute", files: ["notes.md"] }], goals: ["Pick the song."] };
  const ctx = { room, llm: new OfflineLLM(), askedBy: "leo" };
  const r = await recordDaily(ctx, digest);
  assert.equal(r.number, 1);
  assert.equal(r.phase, "astonished");
  const s = room.mustScene(r.sceneId);
  assert.match(s.situation, /first morning/);
  assert.match(s.situation, /Ada Patron: A note on Leonardo's lute/);
  assert.match(s.situation, /cy proposed I-\d+ "A song for the cat"/);
  assert.match(s.situation, /Pick the song/);
  assert.deepEqual(s.cast, ["borges", "leonardo", "agnolo"]);
  assert.ok(existsSync(r.file!));
  assert.match(readFileSync(r.file!, "utf8"), /## What came in[\s\S]*leo\/songs@abcdef1/);
  assert.equal(room.dailies.length, 1);
  await assert.rejects(recordDaily(ctx, digest), /already a daily episode/);
});

test("spawn makes a room of its own that records its first morning", () => {
  const remotes = join(dir, "remotes");
  fakeAsset(remotes, "leo/songs");
  const target = join(dir, "the-lute-room");
  const r = spawnRoom({ idea: "A lute that only plays songs nobody has written yet. People write them.", name: "the-lute-room", dir: target, assets: [{ repo: "leo/songs", about: "songs" }] });
  assert.equal(r.assets.length, 1);
  for (const f of ["src/cli.ts", "cast.json", "assets.json", "GOALS.md", "ROOM.md", "LICENSE", ".github/workflows/daily.yml", "characters/show-bible.md", "seed/season-1.json"]) assert.ok(existsSync(join(target, f)), f);
  for (const f of ["seed/room-log.jsonl", "seed/episodes", "episodes"]) assert.ok(!existsSync(join(target, f)), `${f} shouldn't be inherited`);
  assert.equal(JSON.parse(readFileSync(join(target, "cast.json"), "utf8")).show, "A lute that only plays songs nobody has written yet");
  assert.match(readFileSync(join(target, ".github/workflows/daily.yml"), "utf8"), /ROOM_MODE: local/);
  assert.match(git(target, "log", "--oneline"), /Spawn A lute/);
  assert.throws(() => spawnRoom({ idea: "again", name: "the-lute-room", dir: target }), /already exists/);

  // Its first morning, offline, with the engine's packages.
  symlinkSync(join(ENGINE_DIR, "node_modules"), join(target, "node_modules"));
  const env = { ...process.env, DATA_DIR: join(target, "room"), ROOM_OFFLINE: "1", REPOS_DISABLED: "1", GOALS_FILE: "", DAILY_DIR: "", CAST_FILE: "" };
  for (const k of ["GOALS_FILE", "DAILY_DIR", "CAST_FILE", "ASSETS_FILE", "CHARACTERS_DIR"]) delete (env as Record<string, string | undefined>)[k];
  const outp = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "daily", "--day", "2026-10-29", "--since", new Date(Date.now() - 3600_000).toISOString()], { cwd: target, env, encoding: "utf8" });
  assert.match(outp, /Daily 1: 2026-10-29/);
  assert.match(outp, /Ada Patron: A note on Leonardo's lute/);
  assert.ok(existsSync(join(target, "episodes/daily/2026-10-29.md")));
  assert.ok(existsSync(join(target, "room/events.jsonl")));
});
