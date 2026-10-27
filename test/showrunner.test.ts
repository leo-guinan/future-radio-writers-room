import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/core/events.ts";
import { Room } from "../src/core/room.ts";
import { seed } from "../src/seed.ts";
import { OfflineLLM } from "../src/agents/llm.ts";
import { explore } from "../src/agents/characters.ts";
import { dressingRoom } from "../src/repos/dressing-room.ts";
import { EpisodeRepo } from "../src/repos/episode-repo.ts";
import { tick } from "../src/showrunner/showrunner.ts";
import { sha256 } from "../src/core/events.ts";

const llm = new OfflineLLM();
let room: Room;

beforeEach(() => {
  process.env.REPOS_DIR = mkdtempSync(join(tmpdir(), "fr-repos-"));
  room = new Room(new EventStore(null));
  seed(room, "leo");
});

const add = (title: string, question: string, extra: Record<string, unknown> = {}) =>
  (room.proposeIdea("patron:ada", {
    title,
    question,
    output: "scene",
    source: "test",
    episodeId: "E02",
    contributor: { name: "Ada", credit: true, reuse: "show-only" },
    ...extra,
  }).payload as { ideaId: string }).ideaId;

test("every character run is a commit in that character's dressing room", async () => {
  const id = add("Yuria's lost broadcast", "What did the announcer hear first?");
  await explore({ room, llm, askedBy: "leo", scope: "producer" }, id);
  for (const c of ["borges", "leonardo", "agnolo"] as const) {
    const dr = dressingRoom(c);
    const h = dr.history();
    assert.equal(h.length, 1);
    assert.equal(h[0].ideaId, id);
    assert.ok(dr.repo.has(h[0].file));
    assert.equal(dr.repo.log().length, 2); // opened + one run
    // the room event points back at the commit, and the commit carries the room event hash
    const ev = room.store.all().find((e) => e.type === "repo.commit" && (e.payload as any).repo === dr.repo.name)!;
    assert.equal((ev.payload as any).sha, dr.repo.head());
    assert.ok(dr.repo.read(h[0].file).includes(`room_event_hash: ${room.store.all().find((e) => e.id === h[0].eventId)!.hash}`));
  }
});

test("the persona is read from the dressing room, so editing it changes the character", async () => {
  const dr = dressingRoom("borges").ensure();
  dr.repo.write("CHARACTER.md", "# Borges\n\nSpeaks only in footnotes.\n");
  dr.repo.commit("Borges: footnotes only");
  const { persona } = await import("../src/agents/characters.ts");
  assert.match(persona("borges"), /footnotes/);
});

test("an episode repo starts with only the show plan and the gates", async () => {
  const t = await tick(room, llm, "E03", { explore: false, includeUnassigned: false });
  const repo = new EpisodeRepo("E03").repo;
  assert.equal(t.load, 0);
  const files = readdirSync(repo.dir).filter((f) => f !== ".git").sort();
  assert.deepEqual(files, ["GATES.md", "SHOW_PLAN.md", "gates.json"]);
  assert.equal(repo.log().at(-1)!.message, "Show plan for E03: Round 1 pick");
});

test("the showrunner explores, projects the cast pinned to commits, and cuts", async () => {
  const id = add("The song Dennis wrote", "What if the unresolved name was the composer?");
  const t = await tick(room, llm, "E02", { includeUnassigned: false });
  assert.deepEqual(t.explored, [id]);
  assert.ok(t.cut.includes(id));
  const ep = new EpisodeRepo("E02");
  for (const f of ["CARD.md", "BEATS.md", "SCRIPT.md"]) assert.ok(ep.repo.has(`cuts/${id}/${f}`));
  const prov = ep.provenance();
  for (const c of ["borges", "leonardo", "agnolo"]) {
    const p = prov.files[`cast/${c}.md`];
    assert.ok(p, `projection for ${c}`);
    assert.equal(p.sha, dressingRoom(c as any).repo.head());
    // the projected persona is exactly the dressing room's at that commit
    assert.ok(ep.repo.read(`cast/${c}.md`).includes(`${p.repo}@${p.sha}`));
    assert.equal(sha256(ep.repo.read(`cast/${c}.md`)), p.sha256);
  }
  assert.equal(room.mustIdea(id).status, "compared");
  assert.equal(room.cuts.length >= 1, true);
  // a second tick doesn't cut it again
  const t2 = await tick(room, llm, "E02", { includeUnassigned: false });
  assert.ok(!t2.cut.includes(id));
});

test("gates switch on as load rises, and every held idea says why", async () => {
  for (let i = 0; i < 11; i++) add(`Idea number ${i} about ${["radios", "angels", "ledgers", "orchestras"][i % 4]}`, `Question ${i} about ${["time", "money", "memory"][i % 3]}?`);
  // give Leonardo and Agnolo a pass on everything without cutting yet
  for (const i of [...room.ideas.values()].filter((x) => x.episodeId === "E02")) await explore({ room, llm, askedBy: "leo", scope: "producer" }, i.ideaId);
  const t = await tick(room, llm, "E02", { explore: false, includeUnassigned: false });
  assert.ok(t.load >= 11);
  assert.ok(t.activeGates.includes("agnolo-score"));
  assert.ok(t.activeGates.includes("signal"));
  assert.ok(!t.activeGates.includes("novelty"));
  // offline Agnolo scores scenes 2+1+2 = 5 → passes the score gate; nobody voted → signal holds them
  assert.equal(t.cut.length, 0);
  assert.ok(t.held.every((h) => h.failed.some((f) => f.gate === "signal")));
  // a vote gets one through
  const first = t.held[0].ideaId;
  room.signal("patron", { ideaId: first, kind: "community", value: 1 });
  const t2 = await tick(room, llm, "E02", { explore: false, includeUnassigned: false });
  assert.deepEqual(t2.cut, [first]);
});

test("capacity queues ready ideas instead of cutting them all", async () => {
  for (let i = 0; i < 4; i++) add(`Distinct ${["comet", "lighthouse", "harbor", "telegraph"][i]}`, `Unrelated ${["owl", "kiln", "fjord", "violin"][i]}?`);
  const t = await tick(room, llm, "E02", { explore: true, includeUnassigned: false });
  assert.equal(t.explored.length, 3); // maxExploresPerTick
  assert.equal(t.cut.length, 2); // maxCutsPerTick
  assert.equal(t.queued.length, 1);
});

test("ask-first ideas wait for confirmed consent", async () => {
  const id = add("A private dream", "Can I hear it before you use it?", { contributor: { name: "Bea", credit: true, reuse: "ask-first" } });
  const t = await tick(room, llm, "E02");
  assert.ok(t.held.find((h) => h.ideaId === id)?.failed.some((f) => f.gate === "consent"));
  room.note("leo", id, "Bea said yes on the call — consent confirmed.");
  const t2 = await tick(room, llm, "E02");
  assert.ok(t2.cut.includes(id));
});

test("the showrunner never touches a released episode", async () => {
  room.advanceEpisode("leo", "E10", "write");
  room.advanceEpisode("leo", "E10", "generate");
  room.advanceEpisode("leo", "E10", "review");
  room.advanceEpisode("leo", "E10", "publish");
  room.release("leo", { episodeId: "E10", version: "v1", uri: "x", sha256: sha256("x"), invitation: "Describe a song." });
  await assert.rejects(() => tick(room, llm, "E10"), /released and locked/);
});
