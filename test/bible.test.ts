import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, check, propose, stale } from "future-radio-character-bible";
import { EventStore } from "../src/core/events.ts";
import { Room } from "../src/core/room.ts";
import { seed } from "../src/seed.ts";
import { OfflineLLM } from "../src/agents/llm.ts";
import { explore, systemFor } from "../src/agents/characters.ts";
import { dressingRoom } from "../src/repos/dressing-room.ts";
import { EpisodeRepo } from "../src/repos/episode-repo.ts";
import { syncAll } from "../src/repos/sync.ts";
import { tick } from "../src/showrunner/showrunner.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "Viewer", GIT_AUTHOR_EMAIL: "v@x", GIT_COMMITTER_NAME: "Viewer", GIT_COMMITTER_EMAIL: "v@x" };
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const llm = new OfflineLLM();
let room: Room;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fr-bible-"));
  process.env.REPOS_DIR = join(tmp, "repos");
  room = new Room(new EventStore(null));
  seed(room, "leo");
});

const idea = () =>
  (room.proposeIdea("patron:ada", {
    title: "The song Dennis wrote",
    question: "What if the unresolved name was the composer?",
    output: "song",
    source: "E10-16",
    episodeId: "E02",
    contributor: { name: "Ada", credit: true, reuse: "show-only" },
  }).payload as { ideaId: string }).ideaId;

/** Give Borges's dressing room a "GitHub" (a bare repo) and a viewer's clone of it. */
function publishBorges() {
  const dr = dressingRoom("borges").ensure();
  const remote = join(tmp, "github", "future-radio-dressing-room-borges.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(dr.repo.dir, "remote", "add", "origin", remote);
  git(dr.repo.dir, "push", "-q", "-u", "origin", "main");
  const viewer = join(tmp, "viewer-clone");
  execFileSync("git", ["clone", "-q", remote, viewer]);
  return { dr, remote, viewer };
}

test("every dressing room opens with a bible and a way for viewers in", () => {
  const dr = dressingRoom("leonardo").ensure();
  for (const f of ["bible/BIBLE.md", "bible/system-prompt.md", "bible/bible.json", "SHOW_BIBLE.md", "CONTRIBUTING.md", ".github/pull_request_template.md", ".github/ISSUE_TEMPLATE/viewer-note.yml", ".github/workflows/character-bible.yml"])
    assert.ok(dr.repo.has(f), f);
  assert.deepEqual(stale(dr.repo.dir), []);
  assert.equal(git(dr.repo.dir, "status", "--porcelain"), "");
  assert.match(dr.repo.read(".github/workflows/character-bible.yml"), /future-radio-character-bible check \. --base/);
});

test("runs and notes keep the committed bible fresh", async () => {
  await explore({ room, llm, askedBy: "leo", scope: "producer" }, idea());
  dressingRoom("agnolo").remember("Prefers to show the receipt before the reasoning", "leo");
  for (const c of ["borges", "leonardo", "agnolo"] as const) {
    const dir = dressingRoom(c).repo.dir;
    assert.deepEqual(stale(dir), [], c);
    assert.equal(git(dir, "status", "--porcelain"), "", c);
  }
  assert.equal(dressingRoom("borges").bible().record.runs, 1);
  assert.match(systemFor("agnolo"), /receipt before the reasoning/); // canon rides along on every run
});

test("a merged viewer PR comes back into the room: canon, prompts and projections", async () => {
  const { dr, viewer } = publishBorges();
  // The viewer talks to Borges locally, proposes a note, and it gets merged on GitHub.
  const rel = propose(viewer, { note: "Borges hums when he finds the right volume.", from: "Ada", experience: "E02 first cut", episode: "E02" });
  git(viewer, "checkout", "-q", "-b", "viewer-note");
  git(viewer, "add", "-A");
  git(viewer, "commit", "-qm", "Viewer note: Borges hums");
  assert.ok(check(viewer, { base: "origin/main" }).ok, "the PR check passes");
  git(viewer, "checkout", "-q", "main");
  git(viewer, "merge", "-q", "--no-ff", "-m", "Merge viewer note", "viewer-note");
  build(viewer); // what the GitHub Action does on push to main
  git(viewer, "add", "-A");
  git(viewer, "commit", "-qm", "Rebuild Borges's character bible");
  git(viewer, "push", "-q", "origin", "main");

  // Meanwhile the room keeps working, so the bible diverged on both sides.
  await explore({ room, llm, askedBy: "leo", scope: "producer" }, idea());

  const results = syncAll(room);
  const b = results.find((r) => r.character === "borges")!;
  assert.equal(b.status, "synced", b.message);
  assert.deepEqual(b.newViewerNotes, [rel]);
  assert.deepEqual(stale(dr.repo.dir), []);
  assert.equal(git(dr.repo.dir, "rev-parse", "HEAD"), git(dr.repo.dir, "rev-parse", "origin/main"), "room history pushed back");
  assert.ok(dr.bible().canon.viewerNotes.some((v) => v.from === "Ada"));
  assert.match(systemFor("borges"), /hums when he finds the right volume.*a viewer/);
  assert.ok(room.store.all().some((e) => e.type === "repo.commit" && /viewer note/.test((e.payload as any).message)));

  // The next first cut projects the viewer's note into the episode.
  await tick(room, llm, "E02", { includeUnassigned: false });
  assert.match(new EpisodeRepo("E02").repo.read("cast/borges.md"), /hums when he finds the right volume.*viewer note from Ada/);
});

test("sync stops on a real conflict instead of forcing it", async () => {
  const { dr, viewer } = publishBorges();
  git(viewer, "config", "user.name", "Viewer");
  // Both sides append different lines to the append-only notes.
  execFileSync("sh", ["-c", `printf -- '- viewer line\\n' >> ${join(viewer, "memory/notes.md")}`]);
  git(viewer, "commit", "-qam", "viewer note line");
  git(viewer, "push", "-q", "origin", "main");
  dr.remember("Room's own note", "leo");
  const r = syncAll(room).find((x) => x.character === "borges")!;
  assert.equal(r.status, "conflict");
  assert.match(r.message!, /memory\/notes\.md/);
  assert.equal(git(dr.repo.dir, "status", "--porcelain"), "", "rebase aborted cleanly");
});
