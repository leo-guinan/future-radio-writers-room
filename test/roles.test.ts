import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/core/events.ts";
import { Room } from "../src/core/room.ts";
import { seed } from "../src/seed.ts";
import { OfflineLLM } from "../src/agents/llm.ts";
import { ask, explore } from "../src/agents/characters.ts";
import { castFile, playedBy, roleOf, roleCharacters } from "../src/core/cast.ts";
import { EpisodeRepo } from "../src/repos/episode-repo.ts";
import { tick } from "../src/showrunner/showrunner.ts";

const llm = new OfflineLLM();
let room: Room;
let dir: string;
const writeCast = (cast: unknown) => writeFileSync(process.env.CAST_FILE!, JSON.stringify(cast));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fr-roles-"));
  process.env.REPOS_DIR = join(dir, "repos");
  process.env.CAST_FILE = join(dir, "cast.json");
  room = new Room(new EventStore(null));
});
afterEach(() => {
  delete process.env.CAST_FILE;
});

test("without cast.json the roles fall back to Future Radio's casting", () => {
  assert.deepEqual(castFile().roles, { memory: "borges", making: "leonardo", accounting: "agnolo" });
  assert.equal(roleOf("leonardo"), "making");
  assert.equal(roleOf("yuria"), undefined);
});

test("cast.json is checked: every role needs its own character", () => {
  writeCast({ roles: { memory: "borges", making: "borges", accounting: "agnolo" } });
  assert.throws(() => castFile(), /each role needs its own character/);
  writeCast({ roles: { memory: "Borges!" } });
  assert.throws(() => castFile(), /needs a character slug/);
});

test("recasting the roles moves the work, the ledger and the cut — without touching code", async () => {
  // Same three characters, different jobs: Agnolo remembers, Borges makes, Leonardo keeps the score.
  writeCast({ show: "Test Radio", host: "yuria", roles: { memory: "agnolo", making: "borges", accounting: "leonardo" } });
  assert.deepEqual(roleCharacters(), ["agnolo", "borges", "leonardo"]);
  seed(room, "leo");
  const id = (room.proposeIdea("patron:ada", {
    title: "The listener's second call",
    question: "What does she ask for next?",
    output: "scene",
    source: "test",
    episodeId: "E02",
    contributor: { name: "Ada", credit: true, reuse: "show-only" },
  }).payload as { ideaId: string }).ideaId;

  const { memory, created, judged } = await explore({ room, llm, askedBy: "leo", scope: "producer" }, id);
  const run = (evId: string) => room.store.all().find((e) => e.id === evId)!.payload as { character: string; role: string };
  assert.deepEqual([run(memory.run.id), run(created.run.id), run(judged.run.id)].map((r) => [r.role, r.character]), [
    ["memory", "agnolo"],
    ["making", "borges"],
    ["accounting", "leonardo"],
  ]);
  // Compute is booked by whoever plays accounting.
  assert.ok(room.store.all().some((e) => e.type === "ledger.entry" && e.actor === "leonardo"));
  // Asking by role or by character reaches the same job.
  const byRole = await ask({ room, llm, askedBy: "patron:ada", scope: "public" }, "accounting", "Is it worth it?", id);
  assert.equal(run(byRole.run.id).character, "leonardo");
  await assert.rejects(() => ask({ room, llm, askedBy: "patron:ada", scope: "public" }, "yuria", "Hello?", id), /doesn't play a role/);

  // The showrunner finds the work by role and writes the cut with the new casting.
  const t = await tick(room, llm, "E02", { includeUnassigned: false });
  assert.ok(t.cut.includes(id));
  const script = new EpisodeRepo("E02").repo.read(`cuts/${id}/SCRIPT.md`);
  assert.match(script, /YURIA: This is Test Radio\./);
  assert.match(script, /^AGNOLO: /m); // memory
  assert.match(script, /^BORGES: Three sketches/m); // making, in the making role's offline voice
  assert.equal(playedBy("making"), "borges");
});
