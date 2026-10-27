import { test } from "node:test";
import assert from "node:assert/strict";
import { EventStore, sha256 } from "../src/core/events.ts";
import { Room, RuleError } from "../src/core/room.ts";
import { seed } from "../src/seed.ts";
import { explore, search } from "../src/agents/characters.ts";
import { OfflineLLM } from "../src/agents/llm.ts";
import { account, checklist } from "../src/production/loop.ts";

const fresh = () => {
  const room = new Room(new EventStore(null));
  seed(room, "leo");
  return room;
};
const rule = (fn: () => unknown, name: string) =>
  assert.throws(fn, (e: unknown) => e instanceof RuleError && e.rule === name);

const patronIdea = (room: Room, extra = {}) =>
  (room.proposeIdea("patron:ada", {
    title: "Yuria's lost broadcast",
    question: "What did the announcer hear before the ending arrived?",
    output: "scene",
    source: "Episode 10's invitation",
    episodeId: "E02",
    contributor: { name: "Ada", credit: true, reuse: "show-only", contact: "ada@example.com" },
    ...extra,
  }).payload as { ideaId: string }).ideaId;

test("seed builds the season and Episode 10's selection", () => {
  const room = fresh();
  assert.equal(room.episodes.size, 10);
  const e10 = room.mustEpisode("E10");
  assert.equal(e10.stage, "select");
  assert.equal([...e10.scenes.values()].filter((s) => s.selected).length, 10);
  assert.equal(room.forecasts.size, 5);
  assert.ok(room.store.verify().ok);
  assert.throws(() => seed(room), /already has history/);
});

test("the hash chain detects tampering", () => {
  const room = fresh();
  const ev = room.store.all()[5] as any;
  ev.payload.title = "rewritten history";
  const v = room.store.verify();
  assert.equal(v.ok, false);
});

test("ideas move forward, exits stay in the archive", () => {
  const room = fresh();
  const id = patronIdea(room);
  rule(() => room.transitionIdea("leo", { ideaId: id, to: "explored", reason: "" }), "selection");
  room.transitionIdea("leo", { ideaId: id, to: "compared", reason: "round 1" });
  rule(() => room.transitionIdea("leo", { ideaId: id, to: "explored", reason: "back" }), "lifecycle");
  rule(() => room.transitionIdea("leo", { ideaId: id, to: "produced", reason: "made" }), "lifecycle"); // needs result
  room.transitionIdea("leo", { ideaId: id, to: "declined", reason: "duplicate of the roll call" });
  rule(() => room.transitionIdea("leo", { ideaId: id, to: "proposed", reason: "revive" }), "lifecycle");
});

test("deferred ideas can return to proposed", () => {
  const room = fresh();
  const dennis = [...room.ideas.values()].find((i) => i.title === "Who Is Dennis?")!;
  assert.equal(dennis.status, "deferred");
  room.transitionIdea("leo", { ideaId: dennis.ideaId, to: "proposed", reason: "Round 3 wants a mystery" });
  assert.equal(room.mustIdea(dennis.ideaId).status, "proposed");
});

test("financial support needs a receipt; signals stay separate", () => {
  const room = fresh();
  const id = patronIdea(room);
  rule(() => room.signal("leo", { ideaId: id, kind: "financial", value: 25 }), "receipts");
  room.signal("leo", { ideaId: id, kind: "financial", value: 25, receipt: "stripe_pi_123" });
  room.signal("patron", { ideaId: id, kind: "community", value: 1 });
  room.signal("leo", { ideaId: id, kind: "creative", value: 3 });
  const row = room.board().find((r) => r.ideaId === id)!;
  assert.deepEqual([row.creative, row.community, row.financial], [3, 1, 25]);
});

test("cash ceiling holds until explicitly authorized", () => {
  const room = fresh();
  const base = { ledger: "operations" as const, kind: "expense" as const, unit: "usd" as const, status: "observed" as const, episodeId: "E10" };
  room.addLedgerEntry("leo", { ...base, amount: 15, label: "voices" });
  rule(() => room.addLedgerEntry("leo", { ...base, amount: 6, label: "music" }), "budget");
  // projected spend never counts against observed
  room.addLedgerEntry("leo", { ...base, status: "projected", amount: 100, label: "dream budget" });
  room.authorizeBudget("leo", { episodeId: "E10", newCeiling: 30, reason: "music cue needs one more render" });
  room.addLedgerEntry("leo", { ...base, amount: 6, label: "music" });
  assert.equal(room.episodeCash("E10"), 21);
  const sc = room.scorecard();
  assert.equal(sc.operations.observed.expenses, 21);
  assert.equal(sc.operations.projected.expenses, 100);
});

test("observed receipts need evidence; hours live in the effort ledger", () => {
  const room = fresh();
  rule(() => room.addLedgerEntry("leo", { ledger: "operations", kind: "receipt", amount: 50, unit: "usd", status: "observed", label: "patron" }), "receipts");
  rule(() => room.addLedgerEntry("leo", { ledger: "operations", kind: "hours", amount: 3, unit: "hours", status: "observed", label: "x" }), "ledger");
});

test("the production loop runs in order and a release locks the episode", () => {
  const room = fresh();
  rule(() => room.advanceEpisode("leo", "E10", "generate"), "production");
  room.advanceEpisode("leo", "E10", "write");
  room.addAsset("leo", { episodeId: "E10", kind: "script", label: "six-sequence script", uri: "scripts/e10.md" });
  room.advanceEpisode("leo", "E10", "generate");
  room.addAsset("leo", { episodeId: "E10", kind: "audio", label: "mix v1", uri: "audio/e10-v1.mp3" });
  room.advanceEpisode("leo", "E10", "review");
  rule(() => room.release("leo", { episodeId: "E10", version: "v1", uri: "x", sha256: sha256("x"), invitation: "describe a song" }), "production");
  room.advanceEpisode("leo", "E10", "publish", "one listen-through, two defects fixed");
  room.release("leo", { episodeId: "E10", version: "v1", uri: "https://example.com/e10.mp3", sha256: sha256("audio"), invitation: "Describe a song that doesn't exist yet." });
  rule(() => room.release("leo", { episodeId: "E10", version: "v1", uri: "y", sha256: sha256("y"), invitation: "again" }), "immutable");
  rule(() => room.selectScene("leo", { episodeId: "E10", sceneId: "E10-16", selected: true, reason: "add Dennis back" }), "immutable");
  rule(() => room.addScene("leo", { episodeId: "E10", sceneId: "E10-17", title: "x", role: "x", minutes: [1, 1], summary: "x", question: "x", core: false }), "immutable");
  account(room, "leo", "E10", { cashUsd: 12.4, cashEvidence: "elevenlabs-invoice-1", hours: 7, learned: "Cut the roll call earlier." });
  const done = checklist(room, "E10").filter((c) => c.done).map((c) => c.task);
  assert.ok(done.includes("Publish with a writers' room invitation"));
  assert.ok(done.includes("Archive the file, source text, costs and production time"));
});

test("forecasts resolve once and keep their original wording", () => {
  const room = fresh();
  const [f] = room.forecasts.values();
  room.resolveForecast("agnolo", { forecastId: f.forecastId, outcome: "failed", observation: "Two episodes in three days" });
  rule(() => room.resolveForecast("agnolo", { forecastId: f.forecastId, outcome: "supported", observation: "changed my mind" }), "immutable");
  assert.equal(room.forecasts.get(f.forecastId)!.claim, f.claim);
});

test("patrons never see contact details or producer-only records", () => {
  const room = fresh();
  patronIdea(room);
  const pub = room.publicEvents();
  assert.ok(!JSON.stringify(pub).includes("ada@example.com"));
  assert.ok(!pub.some((e) => e.type === "forecast.recorded" && JSON.stringify(e.payload).includes("$250/month")));
  const anon = patronIdea(room, { contributor: { name: "Bea", credit: false, reuse: "ask-first" } });
  const ev = room.publicEvents().find((e) => (e.payload as any).ideaId === anon && e.type === "idea.proposed")!;
  assert.equal((ev.payload as any).contributor.name, "anonymous patron");
});

test("Borges retrieves from the archive and the room explores offline", async () => {
  const room = fresh();
  const hits = search(room, "angel investor return", "public");
  assert.ok(hits.length > 0);
  assert.ok(hits.some((h) => h.text.includes("Angel")));
  const id = patronIdea(room);
  const r = await explore({ room, llm: new OfflineLLM(), askedBy: "leo", scope: "producer" }, id);
  assert.equal(room.mustIdea(id).status, "explored");
  assert.equal(r.created.approaches.length, 3);
  assert.ok(r.created.approaches.every((a) => a.stoppingRule));
  assert.equal(room.mustIdea(id).runs.length, 3);
  // compute is on the ledger, at $0 observed when offline
  assert.ok(room.ledger.some((l) => l.label.startsWith("borges run") && l.status === "observed" && l.amount === 0));
});

test("Agnolo overrules 'select' when nothing fits the budget", async () => {
  const room = fresh();
  const id = patronIdea(room);
  room.addLedgerEntry("leo", { ledger: "operations", kind: "expense", amount: 19, unit: "usd", status: "observed", label: "most of it", episodeId: "E02" });
  const fake = {
    offline: false,
    model: "fake",
    async complete() {
      return { text: 'Hm.\n```json\n{"scores":{"story":3,"business":2,"participation":3},"why":{"story":"","business":"","participation":""},"claims":[],"evidence":"","recommend":"select","reason":"great"}\n```', usage: { input: 10, output: 10 }, costUsd: null, model: "fake", offline: false };
    },
  };
  const { agnolo } = await import("../src/agents/characters.ts");
  const r = await agnolo({ room, llm: fake, askedBy: "leo", scope: "producer" }, id, [
    { title: "big", deliverable: "x", runtimeMinutes: 5, stoppingRule: "y", estCashUsd: 8, estHours: 2, reuses: [], risk: "" },
  ]);
  assert.equal(r.evaluation.recommend, "compare");
  assert.ok(r.run.payload.flags?.includes("select overruled: over budget"));
  // unpriced compute is unknown, not free
  assert.ok(room.ledger.some((l) => l.label.startsWith("agnolo run") && l.status === "unknown" && l.unit === "tokens"));
});
