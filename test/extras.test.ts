import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { characterFolders, check, propose, stale } from "future-radio-character-bible";
import { EventStore } from "../src/core/events.ts";
import { Room } from "../src/core/room.ts";
import { principals } from "../src/core/cast.ts";
import { seed } from "../src/seed.ts";
import { importEpisode } from "../src/production/import.ts";
import { dressingRoom } from "../src/repos/dressing-room.ts";
import { extrasRepo } from "../src/repos/extras.ts";
import { EpisodeRepo } from "../src/repos/episode-repo.ts";
import { syncAll } from "../src/repos/sync.ts";
import { tick } from "../src/showrunner/showrunner.ts";
import { OfflineLLM } from "../src/agents/llm.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "Viewer", GIT_AUTHOR_EMAIL: "v@x", GIT_COMMITTER_NAME: "Viewer", GIT_COMMITTER_EMAIL: "v@x" };
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const E01 = join(process.cwd(), "seed/episodes/e01");
let tmp: string;
let room: Room;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fr-extras-"));
  process.env.REPOS_DIR = join(tmp, "repos");
  process.env.CAST_FILE = join(tmp, "cast.json");
  copyFileSync(join(process.cwd(), "cast.json"), process.env.CAST_FILE);
  delete process.env.GITHUB_OWNER;
  room = new Room(new EventStore(null));
  seed(room, "leo");
  importEpisode(room, E01);
});

test("E01's extras get folders, appearances, voices and canon", () => {
  const x = extrasRepo();
  assert.deepEqual(x.list(), ["the-cat", "the-unspoken-orchestra", "yuria"]);
  const yuria = x.extra("yuria").bible();
  assert.equal(yuria.name, "Yuria");
  assert.deepEqual(yuria.record.appearances.map((a) => a.episode), ["E01"]);
  assert.equal(yuria.voice.samples[0].line, "—no, leave it on. I like this one.");
  assert.equal(JSON.parse(x.extra("yuria").repo.read("voice/voice.json")).id, "vGfq3y2g8QTWjuUhrNYc");
  assert.ok(yuria.canon.notes.some((n) => n.includes("first proof that someone is there")));
  const cat = x.extra("the-cat").repo.read("history/appearances/E01-v1.md");
  assert.match(cat, /4 cues, no spoken lines/);
  assert.equal(x.extra("the-unspoken-orchestra").bible().name, "The Unspoken Orchestra");
  assert.match(x.repo.log(50).map((l) => l.message).join("\n"), /Open Yuria's folder in the extras/);
  assert.equal(x.extra("the-cat").bible().name, "The cat");
  // every folder is a valid character for the bible tool, and fresh
  for (const d of characterFolders(x.repo.dir)) assert.deepEqual(stale(d), [], d);
  assert.match(x.repo.read("README.md"), /\| \[Yuria\]\(yuria\/\) \|.*\| E01 \|/);
  assert.match(x.repo.read("README.md"), /\| \[The Unspoken Orchestra\]\(the-unspoken-orchestra\/\) \|.*\| E01 \|/);
  assert.ok(x.repo.has(".github/workflows/character-bible.yml"));
  // principals are untouched
  assert.deepEqual(principals(), ["borges", "leonardo", "agnolo"]);
  // re-import adds nothing
  const before = x.repo.head();
  importEpisode(room, E01);
  assert.equal(x.repo.head(), before);
});

test("viewer PRs on the extras are checked one folder at a time", () => {
  const x = extrasRepo();
  const remote = join(tmp, "github", "future-radio-extras.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(x.repo.dir, "remote", "add", "origin", remote);
  git(x.repo.dir, "push", "-q", "-u", "origin", "main");
  const viewer = join(tmp, "viewer");
  execFileSync("git", ["clone", "-q", remote, viewer]);
  git(viewer, "checkout", "-q", "-b", "note");
  const rel = propose(join(viewer, "yuria"), { note: "She leaves the radio on for the cat.", from: "Ada", experience: "E01, the listener in the static", episode: "E01" });
  git(viewer, "add", "-A");
  git(viewer, "commit", "-qm", "Viewer note on Yuria");
  for (const d of characterFolders(viewer)) assert.ok(check(d, { base: "origin/main" }).ok, d);
  // merge it upstream, keep working in the room, then sync
  git(viewer, "checkout", "-q", "main");
  git(viewer, "merge", "-q", "--no-ff", "-m", "merge", "note");
  git(viewer, "push", "-q", "origin", "main");
  dressingRoom("borges"); // room carries on
  const r = syncAll(room).find((s) => s.repo === "extras")!;
  assert.equal(r.status, "synced", r.message);
  assert.deepEqual(r.newViewerNotes, [`yuria/${rel}`]);
  assert.equal(x.signals("yuria", room).viewerNotes, 1);
  assert.equal(git(x.repo.dir, "rev-parse", "HEAD"), git(x.repo.dir, "rev-parse", "origin/main"));
});

test("an idea that mentions an extra brings their folder into the cut", async () => {
  const id = (room.proposeIdea("patron:ada", {
    title: "Who was the listener in the static talking to?",
    question: "What made her leave it on?",
    output: "scene",
    source: "E01-03",
    episodeId: "E02",
    contributor: { name: "Ada", credit: true, reuse: "show-only" },
  }).payload as { ideaId: string }).ideaId;
  const t = await tick(room, new OfflineLLM(), "E02", { includeUnassigned: false });
  assert.ok(t.cut.includes(id));
  const repo = new EpisodeRepo("E02");
  assert.ok(repo.repo.has("cast/extras/yuria.md"));
  assert.match(repo.repo.read("cast/extras/yuria.md"), /# Yuria in E02/);
  assert.match(repo.repo.read("cast/extras/yuria.md"), /I like this one/);
  assert.ok(!repo.repo.has("cast/extras/the-cat.md"));
  assert.equal(repo.provenance().files["cast/extras/yuria.md"].repo, "extras/yuria");
});

test("promotion moves an extra into a dressing room with their history", () => {
  const x = extrasRepo();
  // people like her
  for (let i = 0; i < 5; i++) {
    const id = (room.proposeIdea(`patron:p${i}`, { title: `Yuria idea ${i}`, question: "More Yuria?", output: "scene", source: "E01", contributor: { name: `P${i}`, credit: true, reuse: "show-only" } }).payload as { ideaId: string }).ideaId;
    room.signal("patron", { ideaId: id, kind: "community", value: 1 });
  }
  const s = x.signals("yuria", room);
  assert.equal(s.votes, 5);
  assert.equal(s.worthConsidering, false); // one released appearance; the bar is two

  const r = x.promote("yuria", "Listeners kept asking who she was talking to.");
  assert.ok(r.carried >= 3);
  const dr = dressingRoom("yuria");
  const log = dr.repo.log(100).map((l) => l.message);
  assert.ok(log.some((m) => m.includes("appears in E01 v1")), log.join("\n"));
  assert.ok(log.some((m) => m.includes("Open Yuria's folder in the extras")));
  for (const f of ["CHARACTER.md", "history/appearances/E01-v1.md", "bible/BIBLE.md", "SHOW_BIBLE.md", "README.md", "CONTRIBUTING.md", ".github/workflows/character-bible.yml"]) assert.ok(dr.repo.has(f), f);
  assert.deepEqual(stale(dr.repo.dir), []);
  assert.deepEqual(dr.bible().record.appearances.map((a) => a.episode), ["E01"]);
  assert.ok(dr.notes().some((n) => n.includes("Promoted from the extras")));
  // the extras keep a forwarding address
  assert.deepEqual(x.list(), ["the-cat", "the-unspoken-orchestra"]);
  assert.match(x.repo.read("yuria/PROMOTED.md"), /dressing-room-yuria/);
  assert.match(x.repo.read("README.md"), /## Promoted/);
  // she's a principal now; a re-import finds her in her new home and adds nothing
  assert.ok(principals().includes("yuria"));
  assert.match(readFileSync(process.env.CAST_FILE!, "utf8"), /"yuria"/);
  const head = dr.repo.head();
  importEpisode(room, E01);
  assert.equal(dr.repo.head(), head);
  assert.throws(() => x.open("yuria"), /dressing room of their own/);
});
