import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/core/events.ts";
import { Room } from "../src/core/room.ts";
import { seed } from "../src/seed.ts";
import { importEpisode, linesFor } from "../src/production/import.ts";
import { checklist } from "../src/production/loop.ts";
import { dressingRoom } from "../src/repos/dressing-room.ts";
import { EpisodeRepo } from "../src/repos/episode-repo.ts";
import { tick } from "../src/showrunner/showrunner.ts";
import { OfflineLLM } from "../src/agents/llm.ts";
import { stale } from "future-radio-character-bible";

process.env.REPOS_DIR = mkdtempSync(join(tmpdir(), "fr-import-"));
delete process.env.GITHUB_OWNER;

test("both speaker styles are read from a script", () => {
  const s = "**LEONARDO:** Forty-seven florins.\n**AGNOLO** (from the next room): Maestro. The ledger.\n[SFX: door]\n**LEONARDO** (to the cat): It has opinions.";
  assert.deepEqual(linesFor(s, "leonardo"), ["Forty-seven florins.", "It has opinions."]);
  assert.deepEqual(linesFor(s, "agnolo"), ["Maestro. The ledger."]);
});

test("Episode 1 imports as a released, accounted, locked episode — once", () => {
  const room = new Room(new EventStore(null));
  seed(room, "leo");
  const r = importEpisode(room, join(process.cwd(), "seed/episodes/e01"));
  assert.equal(r.recorded, true);
  const ep = room.mustEpisode("E01");
  assert.equal(ep.stage, "account");
  assert.equal(ep.releases[0].sha256, "0eb6a278f688a84f429cc89f8bb3efd9c843ed17a1bee6fc20fc32948b801b04");
  assert.ok(checklist(room, "E01").every((c) => c.done), JSON.stringify(checklist(room, "E01")));
  assert.equal(room.episodeCash("E01"), 4.83);
  assert.equal(room.episodeDays("E01"), 30);
  assert.ok([...room.forecasts.values()].some((f) => /Episode 002 will cost about \$20/.test(f.claim)));
  assert.ok([...room.ideas.values()].some((i) => i.title.startsWith("Orchestra escalation") && i.status === "declined"));

  // the cast now carries the episode
  const leo = dressingRoom("leonardo").bible();
  assert.deepEqual(leo.record.appearances.map((a) => a.episode), ["E01"]);
  assert.ok(leo.canon.notes.some((n) => n.includes("research cat")));
  assert.equal(JSON.parse(dressingRoom("borges").repo.read("voice/voice.json")).id, "TLugb594bskyzPlFSOkh");
  for (const c of ["leonardo", "borges", "agnolo"] as const) assert.deepEqual(stale(dressingRoom(c).repo.dir), [], c);

  // the episode repo is tagged at the release and projects the cast as of it
  const repo = new EpisodeRepo("E01").repo;
  for (const f of ["SHOW_PLAN.md", "SCRIPT.md", "RELEASE.md", "LEDGER.md", "ASSETS.md", "DECISIONS.md", "OPEN.md", "songs/make-it-with-me.md", "cast/borges.md"]) assert.ok(repo.has(f), f);
  assert.match(repo.read("cast/borges.md"), /history\/appearances\/E01-v1\.md/);
  assert.ok(repo.git(["tag", "-l", "v1"]));

  // run it again: nothing new
  const again = importEpisode(room, join(process.cwd(), "seed/episodes/e01"));
  assert.equal(again.recorded, false);
  assert.equal(again.canonAdded, 0);
  assert.equal(dressingRoom("leonardo").bible().record.appearances.length, 1);
});

test("the showrunner leaves the imported episode alone", async () => {
  const room = new Room(new EventStore(null));
  seed(room, "leo");
  importEpisode(room, join(process.cwd(), "seed/episodes/e01"));
  await assert.rejects(() => tick(room, new OfflineLLM(), "E01"), /released and locked/);
});
