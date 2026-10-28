import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/core/events.ts";
import { Room, RuleError } from "../src/core/room.ts";
import { seed } from "../src/seed.ts";
import { OfflineLLM, type LLM } from "../src/agents/llm.ts";
import { clean, closeScene, openScene, publicScene, runScene, sceneMarkdown } from "../src/scenes/scenes.ts";
import { cacheKey, lineAudio, spokenText } from "../src/scenes/voice.ts";

const card = JSON.parse(readFileSync(new URL("../scenes/cards/two-songs.json", import.meta.url), "utf8"));
const { cast, ...rest } = card;
let room: Room;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "fr-scenes-"));
  process.env.REPOS_DIR = join(dir, "repos");
  process.env.REPOS_DISABLED = "1";
  process.env.VOICE_CACHE_DIR = join(dir, "voice");
  process.env.VOICE_MAP = JSON.stringify({ agnolo: "voice-agnolo", leonardo: "voice-leonardo" });
  delete process.env.TTS_PRICE_PER_1K_CHARS;
  room = new Room(new EventStore(null));
  seed(room);
});

/** A model that always has a line ready, so the voice path has something to say. */
const scripted = (lines: string[]): LLM => {
  let i = 0;
  return {
    offline: false,
    model: "scripted",
    async complete({ user }: { user: string }) {
      const text = user.includes("Decide the next line") ? "not json" : lines[i++ % lines.length];
      return { text, offline: false, model: "scripted", usage: { input: 10, output: 10 }, costUsd: 0 };
    },
  } as unknown as LLM;
};

test("a scene needs a card, two characters and a motivation each", () => {
  const ctx = { room, llm: new OfflineLLM(), askedBy: "leo" };
  assert.throws(() => openScene(ctx, { ...rest, stoppingRule: "" }, cast), /stopping rule/);
  assert.throws(() => openScene(ctx, rest, cast.slice(0, 1)), /at least two/);
  assert.throws(() => openScene(ctx, rest, [cast[0], { ...cast[1], motivation: " " }]), /needs a motivation/);
});

test("offline, the director goes round the cast and closes at the turn limit", async () => {
  const ctx = { room, llm: new OfflineLLM(), askedBy: "leo" };
  const s = openScene(ctx, { ...rest, maxTurns: 4 }, cast);
  const done = await runScene(ctx, s.sceneId);
  assert.equal(done.turns.length, 4);
  assert.deepEqual(done.turns.map((t) => t.character), ["agnolo", "leonardo", "agnolo", "leonardo"]);
  assert.ok(done.closed);
  assert.match(done.closed!.reason, /4 turns/);
  assert.throws(() => room.recordSceneTurn("leo", { sceneId: s.sceneId, character: "agnolo", line: "one more", runId: "x" }), RuleError);
});

test("motivations stay private until the scene closes", async () => {
  const ctx = { room, llm: new OfflineLLM(), askedBy: "leo" };
  const s = openScene(ctx, { ...rest, maxTurns: 2 }, cast);
  const secret = cast[0].motivation;
  const publicNow = () => JSON.stringify(room.publicEvents());
  assert.ok(!publicNow().includes(secret));
  assert.equal(publicScene(room.mustScene(s.sceneId)).motivations, null);
  await runScene(ctx, s.sceneId, { maxSteps: 1 });
  assert.ok(!publicNow().includes(secret), "a line doesn't leak the motivation");
  closeScene(ctx, room.mustScene(s.sceneId), "producer called it");
  assert.ok(publicNow().includes(secret));
  assert.equal(publicScene(room.mustScene(s.sceneId)).motivations!.agnolo, secret);
  assert.match(sceneMarkdown(room.mustScene(s.sceneId)), /What each of them wanted/);
});

test("a card can keep motivations secret for good", async () => {
  const ctx = { room, llm: new OfflineLLM(), askedBy: "leo" };
  const s = openScene(ctx, { ...rest, maxTurns: 2, revealMotivations: false }, cast);
  await runScene(ctx, s.sceneId);
  assert.ok(!JSON.stringify(room.publicEvents()).includes(cast[0].motivation));
});

test("each line is a recorded run by its speaker", async () => {
  const ctx = { room, llm: scripted(["Choose.", "Both."]), askedBy: "leo" };
  const s = openScene(ctx, { ...rest, maxTurns: 2 }, cast);
  const done = await runScene(ctx, s.sceneId);
  assert.deepEqual(done.turns.map((t) => t.line), ["Choose.", "Both."]);
  const runs = room.store.all().filter((e) => e.type === "agent.run" && (e.payload as { askedBy?: string }).askedBy === `scene:${s.sceneId}`);
  assert.equal(runs.length, 2);
});

test("clean strips names, quotes and stage directions", () => {
  assert.equal(clean('LEONARDO: "*sets down the lute* Both of them."', "leonardo"), "Both of them.");
  assert.equal(clean("Agnolo: One song. (pauses) One.", "agnolo"), "One song. One.");
  assert.equal(spokenText("[softly] Choose."), "Choose.");
});

test("voice is generated once, cached, and on the record and the ledger", async () => {
  const ctx = { room, llm: scripted(["The ledger has room for one song.", "Then the ledger is too small."]), askedBy: "leo" };
  const s = openScene(ctx, { ...rest, maxTurns: 2 }, cast);
  await runScene(ctx, s.sceneId);
  let calls = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls++;
    assert.match(url, /text-to-speech\/voice-agnolo/);
    assert.equal(JSON.parse(String(init.body)).text, "The ledger has room for one song.");
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;
  const ledgerBefore = room.ledger.length;
  const [a, b] = await Promise.all([
    lineAudio(room, s.sceneId, 1, { requestedBy: "patron:ada", apiKey: "k", fetchImpl }),
    lineAudio(room, s.sceneId, 1, { requestedBy: "patron:bo", apiKey: "k", fetchImpl }),
  ]);
  const c = await lineAudio(room, s.sceneId, 1, { requestedBy: "patron:cy", apiKey: "k", fetchImpl });
  assert.equal(calls, 1, "the same line in the same voice is paid for once");
  assert.equal(a.path, b.path);
  assert.equal(c.generated, false);
  assert.ok(a.path.endsWith(`${cacheKey("voice-agnolo", "eleven_v4", "The ledger has room for one song.")}.mp3`));
  assert.ok(room.mustScene(s.sceneId).voiced[1]);
  assert.equal(room.ledger.length, ledgerBefore + 1);
  const entry = room.ledger.at(-1)!;
  assert.equal(entry.unit, "characters");
  assert.equal(entry.status, "unknown");
});

test("without a key, voice says so and the scene is still readable", async () => {
  delete process.env.ELEVENLABS_API_KEY;
  const ctx = { room, llm: scripted(["Choose.", "Both."]), askedBy: "leo" };
  const s = openScene(ctx, { ...rest, maxTurns: 2 }, cast);
  await runScene(ctx, s.sceneId);
  await assert.rejects(lineAudio(room, s.sceneId, 1, { requestedBy: "leo" }), /ELEVENLABS_API_KEY/);
  assert.equal(room.mustScene(s.sceneId).turns.length, 2);
});

test("offline placeholder lines are never voiced", async () => {
  const ctx = { room, llm: new OfflineLLM(), askedBy: "leo" };
  const s = openScene(ctx, { ...rest, maxTurns: 2 }, cast);
  await runScene(ctx, s.sceneId);
  await assert.rejects(lineAudio(room, s.sceneId, 1, { requestedBy: "leo", apiKey: "k" }), /improvised offline/);
});
