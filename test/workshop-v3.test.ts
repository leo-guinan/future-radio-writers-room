import { test } from "node:test";
import assert from "node:assert/strict";
import { beginAuth } from "../src/workshop/auth.ts";
import { addIdea, addPlayer, attributePlayer, attributionOf, hasPlayer } from "../src/workshop/log.ts";
import { deriveNodes, deriveRewards } from "../src/workshop/derive.ts";
import { handleMcpMessage } from "../src/workshop/mcp.ts";
import { workshopRoutes } from "../src/workshop/routes.ts";
import { NOW, asPlayer, call, registerTestNode, setXEnv, testConfig, testCtx, xMock } from "./workshop-helpers.ts";

const leoConfig = () => ({ producerNode: { ...testConfig().producerNode, allow: ["leo"] } });
const IN_WINDOW = "2026-11-05T12:00:00Z";
const EPOCH = 1288834974657n;
const snowId = (iso: string, seq = 0): string => (((BigInt(Date.parse(iso)) - EPOCH) << 22n) | BigInt(seq)).toString();
const oembedMock = (handle: string) =>
  (async () => ({ ok: true, json: async () => ({ author_url: `https://x.com/${handle}` }) })) as unknown as typeof fetch;

test("a second account through the producer node is refused with the community list", async () => {
  const restore = setXEnv();
  try {
    const ctx = testCtx({ fetchImpl: xMock({ id: "bob", username: "bob", created_at: "2020-01-01T00:00:00Z" }) }, leoConfig());
    asPlayer(ctx, "leo", "leo");
    asPlayer(ctx, "op", "op");
    registerTestNode(ctx, "leo", "http://producer.example", "producer");
    const { nodeId } = registerTestNode(ctx, "op", "http://community.example");
    const routes = workshopRoutes(ctx);
    const { state } = beginAuth("producer");
    const r = await call(routes, "GET", `/api/workshop/auth/x/callback?code=c&state=${encodeURIComponent(state)}`);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "sign_in_through_a_community_node");
    assert.deepEqual(r.json.nodes, [{ nodeId, url: "http://community.example", signIn: `http://community.example/api/workshop/auth/x/start?via=${nodeId}` }]);
    assert.equal(hasPlayer(ctx.store, "bob"), false); // refusal leaves no record
    // An allow-listed first sign-in is admitted and binds the producer node.
    const ctx2 = testCtx({ fetchImpl: xMock({ id: "fresh", username: "fresh", created_at: "2020-01-01T00:00:00Z" }) }, { producerNode: { ...testConfig().producerNode, allow: ["fresh"] } });
    const first = beginAuth("producer");
    const ok = await call(workshopRoutes(ctx2), "GET", `/api/workshop/auth/x/callback?code=c&state=${encodeURIComponent(first.state)}`);
    assert.equal(ok.status, 302);
    assert.equal(attributionOf(ctx2.store, "fresh"), "producer");
  } finally {
    restore();
  }
});

test("noViaPolicy reject refuses; unassigned admits with no operator credit", async () => {
  const restore = setXEnv();
  try {
    const mk = (policy: "reject" | "unassigned") =>
      testCtx({ fetchImpl: xMock({ id: "newbie", username: "newbie", created_at: "2020-01-01T00:00:00Z" }) }, { ...leoConfig(), noViaPolicy: policy });
    const ctxReject = mk("reject");
    asPlayer(ctxReject, "op", "op");
    registerTestNode(ctxReject, "op", "http://c.example");
    const denied = await call(workshopRoutes(ctxReject), "GET", `/api/workshop/auth/x/callback?code=c&state=${encodeURIComponent(beginAuth(null).state)}`);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, "sign_in_through_a_community_node");

    const ctxFree = mk("unassigned");
    asPlayer(ctxFree, "op", "op");
    const { nodeId } = registerTestNode(ctxFree, "op", "http://c.example");
    const admitted = await call(workshopRoutes(ctxFree), "GET", `/api/workshop/auth/x/callback?code=c&state=${encodeURIComponent(beginAuth(null).state)}`);
    assert.equal(admitted.status, 302);
    assert.equal(attributionOf(ctxFree.store, "newbie"), "unassigned");
    assert.equal(deriveNodes(ctxFree.store.all(), ctxFree.config, NOW).find((n) => n.nodeId === nodeId)!.attributedPlayers, 0);
  } finally {
    restore();
  }
});

test("Leo's weight stays 1 after workshares and a build", async () => {
  const ctx = testCtx({ fetchImpl: oembedMock("leo") }, leoConfig());
  const routes = workshopRoutes(ctx);
  const leo = asPlayer(ctx, "leo", "leo");
  const idea = addIdea(ctx, { author: "leo", kind: "game", title: "A", pitch: "p", incentive: "i" });
  for (let i = 0; i < 5; i++) {
    const r = await call(routes, "POST", "/api/workshop/workshares", { body: { url: `https://x.com/leo/status/${snowId(IN_WINDOW, i)}` }, headers: leo });
    assert.equal(r.json.counted, true);
  }
  ctx.store.append("workshop.build", "producer", { ideaId: (idea.payload as any).id, url: "https://x.example", note: "made", builtAt: new Date(NOW).toISOString() }, "public");
  const row = deriveRewards(ctx.store.all(), ctx.config, NOW).players.find((p) => p.xId === "leo")!;
  assert.deepEqual([row.weight, row.fixed, row.n, row.workshares, row.builds], [1, true, 1, 5, 1]);
});

test("the producer node's operator weight stays 1", async () => {
  let nowMs = Date.parse("2026-11-04T10:00:00-05:00");
  const ctx = testCtx({ now: () => nowMs }, leoConfig());
  asPlayer(ctx, "leo", "leo");
  registerTestNode(ctx, "leo", "http://producer.example", "producer");
  attributePlayer(ctx, "leo", "producer");
  const t0 = nowMs;
  for (let m = 0; m <= 60; m++) {
    const at = new Date(t0 + m * 60_000).toISOString();
    ctx.store.append("workshop.heartbeat", "node:producer", { nodeId: "producer", at, sig: "fixture" }, "public", at);
  }
  nowMs = t0 + 120 * 60_000;
  const node = deriveNodes(ctx.store.all(), ctx.config, nowMs).find((n) => n.nodeId === "producer")!;
  assert.equal(node.qualifies, true);
  assert.equal(node.weight, 1);
  assert.equal(node.capped, true);
  const standings: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "node_standings", arguments: {} } });
  const env = JSON.parse(standings.result.content[0].text);
  assert.deepEqual(env.result.map((n: any) => [n.nodeId, n.n]), [["producer", "1 (capped)"]]);
});

test("pool arithmetic still sums exactly to R, with the producer included", () => {
  const ctx = testCtx({}, { ...leoConfig(), rewardAmount: 1000, pledge: { ...testConfig().pledge, nodeOperatorShareOfParticipants: 0.2 } });
  asPlayer(ctx, "leo", "leo");
  asPlayer(ctx, "bob", "bob");
  registerTestNode(ctx, "leo", "http://producer.example", "producer");
  attributePlayer(ctx, "leo", "producer");
  const { nodeId } = registerTestNode(ctx, "bob", "http://c.example");
  attributePlayer(ctx, "bob", nodeId);
  // Bob earns 3; Leo is fixed at 1 regardless of engagement.
  for (let i = 0; i < 3; i++) {
    const url = `https://x.com/bob/status/7000${i}`;
    ctx.store.append("workshare.recorded", "x:bob", { url, player: "bob", handle: "bob", tweetId: `7000${i}`, tweetedAt: "2026-11-05T12:00:00Z", day: "2026-11-05", counted: true }, "public");
  }
  const r = deriveRewards(ctx.store.all(), ctx.config, NOW);
  assert.deepEqual(r.players.map((p) => [p.handle, p.weight, p.fixed]), [["leo", 1, true], ["bob", 3, false]]);
  assert.equal(r.totals!.sum, 1000);
  assert.equal(r.totals!.players + r.totals!.nodes + r.totals!.nextContest + r.totals!.unallocated, 1000);
});
