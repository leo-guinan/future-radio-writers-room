import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/core/events.ts";
import { Room } from "../src/core/room.ts";
import { seed } from "../src/seed.ts";
import { OpenRouterLLM, anthropicId, makeLLM, type CompleteArgs, type LLM } from "../src/agents/llm.ts";
import { castingFor, modelReport, playEpisode, revealTrial, runTrial, trialMarkdown, type EpisodeCards } from "../src/scenes/trials.ts";
import { publicScene } from "../src/scenes/scenes.ts";

let room: Room;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "fr-trials-"));
  process.env.REPOS_DIR = join(dir, "repos");
  process.env.REPOS_DISABLED = "1";
  room = new Room(new EventStore(null));
  seed(room);
});

/** A fake model service: each model has its own way of talking, and every prompt is kept. */
function fakeModels() {
  const prompts: Array<CompleteArgs> = [];
  const style: Record<string, string> = { "vendor-a/one": "Plainly", "vendor-b/two": "Grandly", "vendor-c/three": "Quietly" };
  const llm: LLM = {
    offline: false,
    model: "vendor-a/one",
    async complete(args) {
      prompts.push(args);
      if (args.user.includes("Decide the next line")) return { text: "no", usage: { input: 1, output: 1 }, costUsd: 0.001, model: args.model ?? "vendor-a/one", offline: false };
      return { text: `${style[args.model ?? "vendor-a/one"] ?? "So"}, line ${prompts.length}.`, usage: { input: 10, output: 5 }, costUsd: 0.002, model: args.model ?? "vendor-a/one", offline: false };
    },
  };
  return { llm, prompts };
}

const episode: EpisodeCards = {
  title: "Two songs, twice",
  guests: { "leo-sim": { name: "Leo (simulated)", persona: "Assembled from the season plan. Knows only what the plan says." } },
  scenes: [
    {
      title: "The choice",
      setting: "After hours.",
      situation: "One slot, two songs.",
      stakes: "A song goes in the drawer.",
      stoppingRule: "He names one.",
      maxTurns: 2,
      cast: [
        { character: "agnolo", motivation: "Get a choice tonight." },
        { character: "leonardo", motivation: "Keep both." },
      ],
    },
    {
      title: "Asking the producer",
      setting: "Same room, later.",
      situation: "They ask a simulation of the producer.",
      stakes: "Whether the plan is the producer.",
      stoppingRule: "They agree or give up.",
      maxTurns: 2,
      cast: [
        { character: "borges", motivation: "Find the receipt." },
        { character: "leo-sim", motivation: "Answer only from the plan." },
      ],
    },
  ],
  lineups: [
    { name: "all A", models: { default: "vendor-a/one" } },
    { name: "B makes", models: { default: "vendor-a/one", making: "vendor-b/two" } },
    { name: "C everywhere", models: { default: "vendor-c/three", director: "vendor-a/one" } },
  ],
};

test("OpenRouter: the model goes per call and the cost comes back observed", async () => {
  const seen: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ model: "vendor-b/two", choices: [{ message: { content: "Both." } }], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.00042 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const llm = new OpenRouterLLM("vendor-a/one", "key", fetchImpl);
  const c = await llm.complete({ system: "s", user: "u", model: "vendor-b/two" });
  assert.equal(seen[0].model, "vendor-b/two");
  assert.deepEqual(seen[0].usage, { include: true });
  assert.equal(c.text, "Both.");
  assert.equal(c.costUsd, 0.00042);
  assert.deepEqual(c.usage, { input: 12, output: 3 });
});

test("provider order: OpenRouter, then Anthropic, then offline", () => {
  const keep = { o: process.env.OPENROUTER_API_KEY, a: process.env.ANTHROPIC_API_KEY };
  process.env.OPENROUTER_API_KEY = "x";
  process.env.ANTHROPIC_API_KEY = "y";
  assert.ok(makeLLM() instanceof OpenRouterLLM);
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(makeLLM().constructor.name, "AnthropicLLM");
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(makeLLM().offline, true);
  if (keep.o) process.env.OPENROUTER_API_KEY = keep.o;
  if (keep.a) process.env.ANTHROPIC_API_KEY = keep.a;
  assert.equal(anthropicId("anthropic/claude-sonnet-5.5"), "claude-sonnet-5-5");
  assert.equal(anthropicId("vendor-b/two"), null);
});

test("a line-up resolves by character, then role, then default", () => {
  const c = castingFor(episode, episode.lineups![1]);
  assert.equal(c.leonardo, "vendor-b/two"); // making
  assert.equal(c.agnolo, "vendor-a/one"); // default
  assert.equal(c.director, "vendor-a/one");
  assert.equal(castingFor(episode, episode.lineups![2]).director, "vendor-a/one");
});

test("an episode plays in order; later scenes remember earlier ones; guests come from the card", async () => {
  const { llm, prompts } = fakeModels();
  const ids = await playEpisode({ room, llm, askedBy: "leo" }, episode, { lineup: episode.lineups![1] });
  assert.equal(ids.length, 2);
  const second = room.mustScene(ids[1]);
  assert.deepEqual(second.after, [ids[0]]);
  assert.equal(publicScene(second).cast.find((c) => c.character === "leo-sim")!.name, "Leo (simulated)");
  const simPrompt = prompts.find((p) => p.system.includes("Assembled from the season plan"))!;
  assert.ok(simPrompt.user.includes("Earlier: The choice"));
  assert.ok(prompts.some((p) => p.model === "vendor-b/two"), "Leonardo ran on the making model");
});

test("a tasting stays blind until revealed, then tallies feedback per line-up and character", async () => {
  const { llm } = fakeModels();
  const ctx = { room, llm, askedBy: "leo" };
  let r = 0.42;
  const t = await runTrial(ctx, episode, episode.lineups, { rand: () => (r = (r * 9301 + 49297) % 233280 / 233280) });
  assert.deepEqual(t.entries.map((e) => e.label), ["A", "B", "C"]);
  const pub = () => JSON.stringify(room.publicEvents());
  for (const m of ["vendor-a/one", "vendor-b/two", "vendor-c/three"]) assert.ok(!pub().includes(m), `${m} leaked before reveal`);
  assert.ok(!trialMarkdown(room, t.trialId).includes("vendor-"));

  room.addTrialFeedback("patron:ada", { trialId: t.trialId, name: "ada", favorite: "B", mostThemselves: { leonardo: "B" }, note: "Leonardo finally sounds like himself." });
  room.addTrialFeedback("patron:bo", { trialId: t.trialId, name: "bo", favorite: "B", mostThemselves: { leonardo: "C" } });
  room.addTrialFeedback("leo", { trialId: t.trialId, name: "leo", favorite: "A" });
  assert.throws(() => room.addTrialFeedback("leo", { trialId: t.trialId, name: "leo", favorite: "C" }), /already/);
  assert.throws(() => room.addTrialFeedback("patron:cy", { trialId: t.trialId, name: "cy", favorite: "Z" }), /Pick one of/);

  revealTrial(ctx, t.trialId);
  const rev = room.mustTrial(t.trialId).revealed!;
  assert.equal(rev.tally.B.favorite, 2);
  assert.equal(rev.responses, 3);
  assert.ok(rev.tally.A.costUsd! > 0);
  assert.ok(pub().includes("vendor-b/two"));
  assert.throws(() => room.addTrialFeedback("patron:late", { trialId: t.trialId, name: "late", favorite: "A" }), /revealed/);

  const leoRows = modelReport(room).filter((x) => x.character === "leonardo");
  const votesFor = (m: string) => leoRows.filter((x) => x.model === m).reduce((n, x) => n + x.mostThemselves, 0);
  const labelOf = (m: string) => Object.entries(rev.lineups).find(([, l]) => l.models.leonardo === m)![0];
  assert.equal(votesFor("vendor-b/two"), rev.tally[labelOf("vendor-b/two")].mostThemselves.leonardo ?? 0);
  assert.equal(leoRows.reduce((n, x) => n + x.mostThemselves, 0), 2);
});
