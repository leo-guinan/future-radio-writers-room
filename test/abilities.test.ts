import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/core/events.ts";
import { Room } from "../src/core/room.ts";
import { seed } from "../src/seed.ts";
import type { CompleteArgs, LLM } from "../src/agents/llm.ts";
import { parseAction, designDir } from "../src/scenes/abilities.ts";
import { openScene, runScene, transcript, sceneMarkdown } from "../src/scenes/scenes.ts";
import { lineAudio } from "../src/scenes/voice.ts";

let room: Room;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "fr-abilities-"));
  process.env.REPOS_DIR = join(dir, "repos");
  process.env.REPOS_DISABLED = "1";
  process.env.VOICE_CACHE_DIR = join(dir, "voice");
  delete process.env.VOICE_DESIGN_PRICE_USD;
  room = new Room(new EventStore(null));
  seed(room);
});

const DESIGN = "DESIGN VOICE for leo-sim | A man in his forties from Ohio, warm, unhurried, a little amused at his own plans. | choose 2";

/** Leonardo designs on his first line if `design` says so; everyone else just talks. Prompts are kept. */
function players(design: string | null = DESIGN) {
  const prompts: CompleteArgs[] = [];
  let leoTurns = 0;
  const llm: LLM = {
    offline: false,
    model: "fake",
    async complete(args) {
      prompts.push(args);
      const done = (text: string) => ({ text, usage: { input: 1, output: 1 }, costUsd: 0, model: "fake", offline: false });
      if (args.user.includes("Decide the next line")) return done("{}");
      if (args.user.includes("Say Leonardo's next line")) return done(leoTurns++ === 0 && design ? `He needs a voice, and I have one in mind.\n${design}` : "Bigger.");
      if (args.user.includes("Say Agnolo's next line")) return done("Who approved this?");
      return done("I can only tell you what I wrote.");
    },
  };
  return { llm, prompts };
}

function elevenlabs() {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    if (url.endsWith("/text-to-voice/design"))
      return new Response(JSON.stringify({ text: "sample", previews: [1, 2, 3].map((k) => ({ audio_base_64: Buffer.from(`mp3-${k}`).toString("base64"), generated_voice_id: `gen-${k}`, media_type: "audio/mpeg", duration_secs: 4.2, language: "en" })) }), { status: 200 });
    if (url.endsWith("/text-to-voice")) return new Response(JSON.stringify({ voice_id: `voice-from-${body.generated_voice_id}` }), { status: 200 });
    if (url.includes("/text-to-speech/")) return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, services: { apiKey: "k", fetchImpl } };
}

const card = () => ({
  title: "The producer they could build",
  setting: "Milliways.",
  situation: "A simulated Leo with no voice.",
  stakes: "Whether a plan can speak.",
  stoppingRule: "They decide.",
  maxTurns: 6,
});
const cast = (abilities: string[] = ["design-voice"], target = "leo-sim") => [
  { character: "leonardo", motivation: "Give him a voice.", abilities },
  { character: "leo-sim", motivation: "Answer from the plans.", name: "Leo (simulated)", persona: "Made of plans." },
  { character: "agnolo", motivation: "Cross-examine him." },
];

test("parseAction splits the spoken line from the order", () => {
  const r = parseAction(`Listen.\n${DESIGN}`);
  assert.equal(r.text, "Listen.");
  assert.deepEqual(r.action, { forCharacter: "leo-sim", description: "A man in his forties from Ohio, warm, unhurried, a little amused at his own plans.", mode: "choose", pick: 2 });
  assert.equal(parseAction("**DESIGN VOICE** for borges | Old, dry, Argentine. | offer").action!.mode, "offer");
  assert.equal(parseAction("No order here.").action, null);
});

test("Leonardo designs a voice mid-scene; the bill lands on Agnolo, who speaks next", async () => {
  const { llm, prompts } = players();
  const el = elevenlabs();
  const ctx = { room, llm, askedBy: "leo", services: el.services };
  const s = openScene(ctx, card(), cast());
  await runScene(ctx, s.sceneId);
  const done = room.mustScene(s.sceneId);

  // The line is spoken without the order in it.
  assert.equal(done.turns[0].character, "leonardo");
  assert.equal(done.turns[0].line, "He needs a voice, and I have one in mind.");
  // Three candidates; candidate 2 saved and given to the guest in this scene.
  assert.equal(el.calls[0].body.voice_description, "A man in his forties from Ohio, warm, unhurried, a little amused at his own plans.");
  assert.equal(el.calls[1].body.generated_voice_id, "gen-2");
  const d = room.voiceDesigns.get("VD-0001")!;
  assert.equal(d.previews.length, 3);
  assert.ok(existsSync(join(designDir(), d.previews[0].file)));
  assert.equal(room.designedVoiceIn(s.sceneId, "leo-sim")!.voiceId, "voice-from-gen-2");
  // The bill: addressed to Agnolo, on the ledger as of unknown cost, and his line is next.
  const bill = done.happenings.find((h) => h.kind === "bill")!;
  assert.equal(bill.addressee, "agnolo");
  assert.match(bill.text, /addressed to Agnolo: ElevenLabs, voice design VD-0001/);
  assert.equal(done.turns[1].character, "agnolo");
  assert.match(done.turns[1].beat!, /This just landed in front of you/);
  const agnoloPrompt = prompts.find((p) => p.user.includes("Say Agnolo's next line"))!;
  assert.match(agnoloPrompt.user, /\[BILL\] A bill arrives/);
  const entry = room.ledger.find((l) => l.label.startsWith("Voice design VD-0001"))!;
  assert.equal(entry.by, "elevenlabs");
  assert.equal(entry.status, "unknown");
  assert.equal(entry.unit, "previews");
  // Once per scene: Leonardo isn't offered it again.
  assert.equal(room.voiceDesigns.size, 1);
  assert.ok(!prompts.filter((p) => p.user.includes("Say Leonardo's next line")).at(-1)!.user.includes("DESIGN VOICE for"));
  assert.match(transcript(done), /\[VOICE\] Leo \(simulated\) has a voice now/);
  assert.match(sceneMarkdown(done), /> \*\*Bill\.\*\*/);

  // The guest's lines play in the new voice, here and in scenes that follow this one.
  const n = done.turns.find((t) => t.character === "leo-sim")!.n;
  await lineAudio(room, s.sceneId, n, { requestedBy: "leo", apiKey: "k", fetchImpl: el.fetchImpl });
  assert.match(el.calls.at(-1)!.url, /text-to-speech\/voice-from-gen-2/);
  const next = openScene(ctx, { ...card(), after: [s.sceneId] }, cast([]));
  assert.equal(room.designedVoiceIn(next.sceneId, "leo-sim")!.voiceId, "voice-from-gen-2");
  const elsewhere = openScene(ctx, card(), cast([]));
  assert.equal(room.designedVoiceIn(elsewhere.sceneId, "leo-sim"), undefined);
});

test("a priced design is booked in dollars", async () => {
  process.env.VOICE_DESIGN_PRICE_USD = "0.30";
  const ctx = { room, llm: players().llm, askedBy: "leo", services: elevenlabs().services };
  const s = openScene(ctx, card(), cast());
  await runScene(ctx, s.sceneId, { maxSteps: 2 });
  const entry = room.ledger.find((l) => l.label.startsWith("Voice design"))!;
  assert.equal(entry.amount, 0.3);
  assert.equal(entry.unit, "usd");
  assert.match(room.mustScene(s.sceneId).happenings.find((h) => h.kind === "bill")!.text, /\$0\.30/);
});

test("a principal can only be offered a voice, never given one on the spot", async () => {
  const el = elevenlabs();
  const ctx = { room, llm: players("DESIGN VOICE for agnolo | Younger, brighter, a Florentine banker. | choose 1").llm, askedBy: "leo", services: el.services };
  const s = openScene(ctx, card(), cast());
  await runScene(ctx, s.sceneId, { maxSteps: 2 });
  assert.equal(room.voiceDesigns.get("VD-0001")!.mode, "offer");
  assert.equal(room.voiceSelections.length, 0);
  assert.ok(!el.calls.some((c) => c.url.endsWith("/text-to-voice")));
});

test("without a key, nothing is designed and nothing is billed", async () => {
  delete process.env.ELEVENLABS_API_KEY;
  const ctx = { room, llm: players().llm, askedBy: "leo" };
  const s = openScene(ctx, card(), cast());
  await runScene(ctx, s.sceneId, { maxSteps: 2 });
  const h = room.mustScene(s.sceneId).happenings;
  assert.equal(h.length, 1);
  assert.equal(h[0].kind, "notice");
  assert.match(h[0].text, /No bill/);
  assert.equal(room.voiceDesigns.size, 0);
});

test("only characters given the ability can use it", async () => {
  const el = elevenlabs();
  const ctx = { room, llm: players().llm, askedBy: "leo", services: el.services };
  const s = openScene(ctx, card(), cast([]));
  await runScene(ctx, s.sceneId, { maxSteps: 2 });
  assert.equal(el.calls.length, 0);
  assert.equal(room.voiceDesigns.size, 0);
  assert.ok(!players().prompts.length);
  assert.throws(() => openScene(ctx, card(), cast(["fly"])), /can't 'fly'/);
});
