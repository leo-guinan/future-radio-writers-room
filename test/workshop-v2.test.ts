import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorkshopConfig } from "../src/workshop/config.ts";
import { WorkshopError, addIdea, addPlayer, attributePlayer, attributionOf } from "../src/workshop/log.ts";
import { deriveNodes, deriveRewards, deriveWorkshares } from "../src/workshop/derive.ts";
import { handleMcpMessage } from "../src/workshop/mcp.ts";
import { workshopRoutes } from "../src/workshop/routes.ts";
import { NOW, asPlayer, call, registerTestNode, testConfig, testCtx } from "./workshop-helpers.ts";

const EPOCH = 1288834974657n;
/** Snowflake id authored at iso (seq disambiguates same-ms tweets). */
const snowId = (iso: string, seq = 0): string => (((BigInt(Date.parse(iso)) - EPOCH) << 22n) | BigInt(seq)).toString();
const commentUrl = (handle: string, id: string) => `https://x.com/${handle}/status/${id}`;
const oembedMock = (handle: string) =>
  (async () => ({ ok: true, json: async () => ({ author_url: `https://x.com/${handle}` }) })) as unknown as typeof fetch;
const IN_WINDOW = "2026-11-05T12:00:00Z";

test("attribution is first-binding-only, and the operator's own account is excluded", async () => {
  const ctx = testCtx();
  const routes = workshopRoutes(ctx);
  asPlayer(ctx, "1", "ada");
  asPlayer(ctx, "2", "bob");
  const { nodeId: n1 } = registerTestNode(ctx, "1", "http://n1.example");
  const { nodeId: n2 } = registerTestNode(ctx, "1", "http://n2.example");
  const first = attributePlayer(ctx, "2", n1);
  assert.equal((first!.payload as any).nodeId, n1);
  assert.equal(attributePlayer(ctx, "2", n2), null); // re-sign-in keeps the first binding
  assert.equal(attributionOf(ctx.store, "2"), n1);
  attributePlayer(ctx, "1", n1); // the operator binds like anyone…
  // v3 retired the "coordinator" fallback: unknown via with policy reject is refused.
  assert.throws(() => attributePlayer(ctx, "3", "N-9999"), (e: unknown) => e instanceof WorkshopError && e.code === "sign_in_through_a_community_node");
  const nodes = deriveNodes(ctx.store.all(), ctx.config, NOW);
  assert.equal(nodes.find((n) => n.nodeId === n1)!.attributedPlayers, 1); // …but never counts toward their own node
  const count = await call(routes, "GET", `/api/workshop/nodes/${n1}/players`);
  assert.deepEqual(count.json, { nodeId: n1, count: 1 }); // count only, never handles
  const missing = await call(routes, "GET", "/api/workshop/nodes/N-9999/players");
  assert.equal(missing.status, 404);
});

test("oEmbed author mismatch is rejected", async () => {
  const ctx = testCtx({ fetchImpl: oembedMock("mallory") });
  const routes = workshopRoutes(ctx);
  const ada = asPlayer(ctx, "1", "ada");
  const r = await call(routes, "POST", "/api/workshop/workshares", { body: { url: commentUrl("ada", snowId(IN_WINDOW)) }, headers: ada });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "author_mismatch");
  assert.equal(ctx.store.all().filter((e) => e.type === "workshare.recorded").length, 0);
});

test("out-of-window and duplicate URLs are rejected", async () => {
  const ctx = testCtx({ fetchImpl: oembedMock("ada") });
  const routes = workshopRoutes(ctx);
  const ada = asPlayer(ctx, "1", "ada");
  const early = await call(routes, "POST", "/api/workshop/workshares", { body: { url: commentUrl("ada", snowId("2020-06-01T00:00:00Z")) }, headers: ada });
  assert.equal(early.status, 400);
  assert.equal(early.json.code, "out_of_window");
  const late = await call(routes, "POST", "/api/workshop/workshares", { body: { url: commentUrl("ada", snowId("2101-01-01T00:00:00Z")) }, headers: ada });
  assert.equal(late.json.code, "out_of_window");
  const bad = await call(routes, "POST", "/api/workshop/workshares", { body: { url: "https://x.com/ada" }, headers: ada });
  assert.equal(bad.json.code, "bad_url");
  const url = commentUrl("ada", snowId(IN_WINDOW));
  const ok = await call(routes, "POST", "/api/workshop/workshares", { body: { url }, headers: ada });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.counted, true);
  assert.equal(ok.json.day, "2026-11-05"); // ET day of the tweet
  const dup = await call(routes, "POST", "/api/workshop/workshares", { body: { url }, headers: ada });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, "duplicate_workshare");
});

test("the daily cap is applied", async () => {
  const ctx = testCtx({ fetchImpl: oembedMock("ada") });
  const routes = workshopRoutes(ctx);
  const ada = asPlayer(ctx, "1", "ada");
  for (let i = 0; i < 5; i++) {
    const r = await call(routes, "POST", "/api/workshop/workshares", { body: { url: commentUrl("ada", snowId(IN_WINDOW, i)) }, headers: ada });
    assert.equal(r.json.counted, true);
  }
  const sixth = await call(routes, "POST", "/api/workshop/workshares", { body: { url: commentUrl("ada", snowId(IN_WINDOW, 5)) }, headers: ada });
  assert.equal(sixth.status, 201); // logged…
  assert.equal(sixth.json.counted, false); // …but not counted
  assert.equal(sixth.json.reason, "daily_cap");
  const nextDay = await call(routes, "POST", "/api/workshop/workshares", { body: { url: commentUrl("ada", snowId("2026-11-06T12:00:00Z")) }, headers: ada });
  assert.equal(nextDay.json.counted, true); // the cap is per ET day
  const all = await call(routes, "GET", "/api/workshop/workshares?player=ada");
  assert.equal(all.json.length, 7);
  assert.equal(all.json.filter((w: any) => w.weight === 1).length, 6);
});

test("the void removes the workshare's weight", async () => {
  const ctx = testCtx({ fetchImpl: oembedMock("ada") });
  const routes = workshopRoutes(ctx);
  const ada = asPlayer(ctx, "1", "ada");
  const url = commentUrl("ada", snowId(IN_WINDOW));
  await call(routes, "POST", "/api/workshop/workshares", { body: { url }, headers: ada });
  assert.equal(deriveWorkshares(ctx.store.all())[0].weight, 1);
  const anon = await call(routes, "POST", "/api/workshop/workshares/void", { body: { url, reason: "x" } });
  assert.equal(anon.status, 401);
  const ghost = await call(routes, "POST", "/api/workshop/workshares/void", {
    body: { url: commentUrl("ada", snowId(IN_WINDOW, 9)), reason: "x" },
    headers: { authorization: "Bearer prod-token" },
  });
  assert.equal(ghost.status, 404);
  const v = await call(routes, "POST", "/api/workshop/workshares/void", {
    body: { url, reason: "Not in the thread." },
    headers: { authorization: "Bearer prod-token" },
  });
  assert.equal(v.status, 201);
  const [w] = deriveWorkshares(ctx.store.all());
  assert.equal(w.voided, true);
  assert.equal(w.weight, 0); // weight gone, history kept
  const again = await call(routes, "POST", "/api/workshop/workshares/void", {
    body: { url, reason: "again" },
    headers: { authorization: "Bearer prod-token" },
  });
  assert.equal(again.status, 409);
});

test("the sqrt node weight and the uptime threshold are applied", () => {
  let nowMs = Date.parse("2026-11-04T10:00:00-05:00"); // opensAt + 1h
  const ctx = testCtx({ now: () => nowMs });
  asPlayer(ctx, "1", "ada");
  for (let i = 2; i <= 14; i++) asPlayer(ctx, String(i), `p${i}`);
  const { nodeId: n1 } = registerTestNode(ctx, "1", "http://n1.example");
  const { nodeId: n2 } = registerTestNode(ctx, "1", "http://n2.example");
  for (let i = 2; i <= 5; i++) attributePlayer(ctx, String(i), n1); // 4 players
  for (let i = 6; i <= 14; i++) attributePlayer(ctx, String(i), n2); // 9 players
  const t0 = nowMs;
  for (let m = 0; m <= 60; m++) {
    const at = new Date(t0 + m * 60_000).toISOString();
    ctx.store.append("workshop.heartbeat", `node:${n1}`, { nodeId: n1, at, sig: "fixture" }, "public", at);
    if (m < 10) ctx.store.append("workshop.heartbeat", `node:${n2}`, { nodeId: n2, at, sig: "fixture" }, "public", at);
  }
  nowMs = t0 + 120 * 60_000; // two hours in: 61/120 up vs 10/120
  const nodes = deriveNodes(ctx.store.all(), ctx.config, nowMs);
  const one = nodes.find((n) => n.nodeId === n1)!;
  const two = nodes.find((n) => n.nodeId === n2)!;
  assert.equal(one.qualifies, true);
  assert.equal(one.weight, 2); // sqrt(4)
  assert.equal(two.qualifies, false); // 9 players, no uptime: no weight
  assert.equal(two.weight, 0);
  const r = deriveRewards(ctx.store.all(), ctx.config, nowMs);
  assert.deepEqual(r.nodes.map((n) => [n.nodeId, n.shareOfO]), [[n1, 1], [n2, 0]]);
});

test("the pool arithmetic sums exactly to R", () => {
  const ctx = testCtx({}, { rewardAmount: 1000, pledge: { ...testConfig().pledge, nodeOperatorShareOfParticipants: 0.2 } });
  asPlayer(ctx, "1", "ada");
  asPlayer(ctx, "2", "bob");
  asPlayer(ctx, "3", "cy");
  const idea = addIdea(ctx, { author: "1", kind: "game", title: "A", pitch: "p", incentive: "i" });
  ctx.store.append("workshop.build", "producer", { ideaId: (idea.payload as any).id, url: "https://x.example", note: "made", builtAt: new Date(NOW).toISOString() }, "public");
  // Weights: ada 2 shares + 1 build×10 = 12; bob 1 share = 1; cy 0.
  const day = "2026-11-05";
  for (const [player, handle, n] of [["1", "ada", 2], ["2", "bob", 1]] as const) {
    for (let i = 0; i < n; i++) {
      const url = `https://x.com/${handle}/status/9000${player}${i}`;
      ctx.store.append("workshare.recorded", `x:${player}`, { url, player, handle, tweetId: `9000${player}${i}`, tweetedAt: `${day}T12:00:00Z`, day, counted: true }, "public");
    }
  }
  const { nodeId } = registerTestNode(ctx, "3", "http://n.example");
  attributePlayer(ctx, "1", nodeId);
  attributePlayer(ctx, "2", nodeId);
  attributePlayer(ctx, "3", nodeId); // operator excluded: 2 counted
  // Full uptime since registration (registered at NOW, horizon NOW: force elapsed via heartbeats is 0/0…).
  const r = deriveRewards(ctx.store.all(), ctx.config, NOW);
  assert.equal(r.status, "projected");
  assert.deepEqual(r.players.map((p) => [p.handle, p.weight]), [["ada", 12], ["bob", 1], ["cy", 0]]);
  assert.equal(r.totals!.sum, 1000); // exact
  assert.equal(r.totals!.players + r.totals!.nodes + r.totals!.nextContest + r.totals!.unallocated, 1000);
  assert.deepEqual(r.pools, { R: 1000, P: 500, O: 100, W: 400, nextContest: 500, operatorUnallocated: 100 });
});

test("pledge loads from config as plain text", () => {
  const config = loadWorkshopConfig();
  assert.ok(config.pledge.text.includes("Story.markets"));
  assert.ok(config.pledge.text.includes("50%"));
  assert.ok(!config.pledge.text.includes("##"), "no markdown headings");
  assert.ok(!config.pledge.text.includes("**"), "no markdown bold");
  assert.ok(!config.pledge.text.split("\n").some((l) => l.startsWith("- ")), "no markdown bullets");
});

test("MCP workshares and node_standings carry asOf and closesAt", async () => {
  const ctx = testCtx();
  asPlayer(ctx, "1", "ada");
  ctx.store.append("workshare.recorded", "x:1", { url: "https://x.com/ada/status/1", player: "1", handle: "ada", tweetId: "1", tweetedAt: "2026-11-05T12:00:00Z", day: "2026-11-05", counted: true }, "public");
  registerTestNode(ctx, "1", "http://n.example");
  for (const [name, args] of [["workshares", { player: "ada" }], ["node_standings", {}], ["rewards", {}]] as const) {
    const r: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const env = JSON.parse(r.result.content[0].text);
    assert.deepEqual(Object.keys(env).sort(), ["asOf", "closesAt", "result"]);
    assert.ok(env.asOf.seq > 0 && env.asOf.time);
  }
  const list: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = list.result.tools.map((t: any) => t.name);
  assert.ok(names.includes("workshares") && names.includes("node_standings"));
});
