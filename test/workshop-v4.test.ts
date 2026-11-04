import { test } from "node:test";
import assert from "node:assert/strict";
import { EventStore } from "../src/core/events.ts";
import { addIdea, addPlayer, attributePlayer, maybeReceipt, payoutMessage, registerNode } from "../src/workshop/log.ts";
import { derivePayoutProfiles, deriveSettlement } from "../src/workshop/derive.ts";
import { handleMcpMessage } from "../src/workshop/mcp.ts";
import { buildRegistration, pullOnce } from "../src/workshop/node.ts";
import { workshopRoutes } from "../src/workshop/routes.ts";
import { asPlayer, authorizeTestNode, call, registerTestNode, signedRegistration, testConfig, testCtx, testEnergy, testNodeKey, testPayout } from "./workshop-helpers.ts";

const oembedMock = (handle: string) =>
  (async () => ({ ok: true, json: async () => ({ author_url: `https://x.com/${handle}` }) })) as unknown as typeof fetch;
const EPOCH = 1288834974657n;
const snowId = (iso: string, seq = 0): string => (((BigInt(Date.parse(iso)) - EPOCH) << 22n) | BigInt(seq)).toString();

test("payout fractions must sum to 1", async () => {
  const ctx = testCtx();
  const routes = workshopRoutes(ctx);
  const op = asPlayer(ctx, "1", "op");
  const key = testNodeKey();
  const badSum = await call(routes, "POST", "/api/workshop/nodes/register", {
    body: signedRegistration(key, "http://n.example", testEnergy(), { qi: 0.5, quai: 0.5, fiat: 0.5, schedule: "now" }),
    headers: op,
  });
  assert.equal(badSum.status, 400);
  assert.equal(badSum.json.code, "bad_payout");
  const badSched = await call(routes, "POST", "/api/workshop/nodes/register", {
    body: signedRegistration(key, "http://n.example", testEnergy(), { qi: 1, quai: 0, fiat: 0, schedule: "weekly" }),
    headers: op,
  });
  assert.equal(badSched.json.code, "bad_payout");
  const good = await call(routes, "POST", "/api/workshop/nodes/register", { body: signedRegistration(key, "http://n.example"), headers: op });
  assert.equal(good.status, 201);
  const nodeId = good.json.nodeId;
  const updBad = await call(routes, "POST", "/api/workshop/nodes/payout", {
    body: { nodeId, payout: { qi: 1, quai: 1, fiat: 0, schedule: "now" }, sig: "x" },
    headers: op,
  });
  assert.equal(updBad.json.code, "bad_payout");
  const forged = await call(routes, "POST", "/api/workshop/nodes/payout", {
    body: { nodeId, payout: { qi: 1, quai: 0, fiat: 0, schedule: "now" }, sig: Buffer.from("forged").toString("base64") },
    headers: op,
  });
  assert.equal(forged.status, 401);
  const latest = { qi: 1, quai: 0, fiat: 0, schedule: "lump_at:2026-12-01" };
  const upd = await call(routes, "POST", "/api/workshop/nodes/payout", {
    body: { nodeId, payout: latest, sig: key.sign(payoutMessage(nodeId, latest)).toString("base64") },
    headers: op,
  });
  assert.equal(upd.status, 201);
  assert.deepEqual(derivePayoutProfiles(ctx.store.all()).get(nodeId), latest); // last one wins
  // Another operator cannot touch this node's profile.
  const bob = asPlayer(ctx, "2", "bob");
  const hijack = await call(routes, "POST", "/api/workshop/nodes/payout", {
    body: { nodeId, payout: latest, sig: key.sign(payoutMessage(nodeId, latest)).toString("base64") },
    headers: bob,
  });
  assert.equal(hijack.status, 403);
});

test("the energy-budget TTL ends the lease", async () => {
  let nowMs = Date.parse("2026-11-05T10:00:00Z");
  const ctx = testCtx({ now: () => nowMs });
  asPlayer(ctx, "1", "op");
  const key = testNodeKey();
  const { nodeId } = registerNode(ctx, {
    operator: "1",
    ...signedRegistration(key, "http://n.example", { watts: 60, source: "grid", evidenceUrl: "https://e.example", budgetWh: 30 }, testPayout()),
  });
  for (let m = 0; m < 35; m++) {
    const at = new Date(nowMs + m * 60_000).toISOString();
    ctx.store.append("workshop.heartbeat", `node:${nodeId}`, { nodeId, at, sig: "fixture", eventsVerified: m, requestsServed: 0, head: "genesis" }, "public", at);
  }
  nowMs = Date.parse("2026-11-05T11:01:00Z");
  const appended = maybeReceipt(ctx);
  const receipt = appended.find((e) => e.type === "energy.receipt");
  assert.deepEqual((receipt!.payload as any).hour, "2026-11-05T10:00:00.000Z");
  assert.equal((receipt!.payload as any).wh, 35); // 60W × 35/60h
  const lease = appended.find((e) => e.type === "node.lease.ended");
  assert.deepEqual([(lease!.payload as any).reason, (lease!.payload as any).receiptedWh], ["energy_budget", 35]);
  const beat = await call(workshopRoutes(ctx), "POST", "/api/workshop/nodes/heartbeat", {
    body: { nodeId, at: new Date(nowMs).toISOString(), sig: "x", eventsVerified: 0, requestsServed: 0, head: "genesis" },
  });
  assert.equal(beat.status, 403);
  assert.equal(beat.json.code, "lease_ended");
});

test("receipt Wh comes from heartbeats only, never from claims", () => {
  let nowMs = Date.parse("2026-11-05T10:00:00Z");
  const ctx = testCtx({ now: () => nowMs });
  asPlayer(ctx, "1", "op");
  const { nodeId } = registerTestNode(ctx, "1"); // 65W declared; budget 5000Wh
  // 90 heartbeats but only 30 distinct minute buckets in the 10:00 hour.
  for (let i = 0; i < 90; i++) {
    const at = new Date(nowMs + (i % 30) * 60_000 + Math.floor(i / 30) * 1000).toISOString();
    ctx.store.append("workshop.heartbeat", `node:${nodeId}`, { nodeId, at, sig: "fixture" }, "public", at);
  }
  nowMs = Date.parse("2026-11-05T12:01:00Z");
  maybeReceipt(ctx);
  const receipts = ctx.store.all().filter((e) => e.type === "energy.receipt").map((e) => e.payload as any);
  assert.equal(receipts.length, 2); // 10:00 with work, 11:00 idle — both recorded
  const [ten, eleven] = receipts;
  assert.equal(ten.heartbeats, 90);
  assert.equal(ten.hoursUp, 0.5); // 30 distinct minutes, not 90 beats
  assert.equal(ten.wh, 32.5); // 65W × 0.5h
  assert.equal(ten.source, "rooftop solar (self-attested)"); // claim copied, never verified
  assert.deepEqual([eleven.wh, eleven.heartbeats], [0, 0]);
});

test("spending workshares on generation reduces player weight correctly", async () => {
  const ctx = testCtx({ fetchImpl: oembedMock("ada") });
  const routes = workshopRoutes(ctx);
  const ada = asPlayer(ctx, "1", "ada");
  const idea = addIdea(ctx, { author: "1", kind: "game", title: "A", pitch: "p", incentive: "i" });
  const ideaId = (idea.payload as any).id;
  for (let i = 0; i < 5; i++) {
    await call(routes, "POST", "/api/workshop/workshares", { body: { url: `https://x.com/ada/status/${snowId("2026-11-05T12:00:00Z", i)}` }, headers: ada });
  }
  const gen = await call(routes, "POST", "/api/workshop/generate", { body: { ideaId }, headers: ada });
  assert.equal(gen.status, 201);
  assert.deepEqual([gen.json.spent, gen.json.remaining], [3, 2]); // cost comes from config
  const again = await call(routes, "POST", "/api/workshop/generate", { body: { ideaId }, headers: ada });
  assert.equal(again.status, 400);
  assert.equal(again.json.code, "insufficient_workshares");
  const ghost = await call(routes, "POST", "/api/workshop/generate", { body: { ideaId: "W-9999" }, headers: ada });
  assert.equal(ghost.status, 404);
  const list = await call(routes, "GET", "/api/workshop/workshares?player=ada");
  assert.equal(list.json.filter((w: any) => w.spent).length, 3);
  assert.equal(list.json.filter((w: any) => w.weight === 1).length, 2);
});

test("settlement is reproducible from the log on a node", async () => {
  let nowMs = Date.parse("2026-11-05T10:00:00Z");
  const ctx = testCtx({ now: () => nowMs }, { rewardAmount: 2000, pledge: { ...testConfig().pledge, nodeOperatorShareOfParticipants: 0.25 } });
  asPlayer(ctx, "1", "op");
  asPlayer(ctx, "2", "ada");
  asPlayer(ctx, "3", "bob");
  asPlayer(ctx, "4", "cy");
  const key = testNodeKey();
  const payout = { qi: 0.5, quai: 0.25, fiat: 0.25, schedule: "stream:2xP7D" };
  const { nodeId } = registerNode(ctx, { operator: "1", ...signedRegistration(key, "http://n.example", testEnergy(), payout) });
  authorizeTestNode(ctx, nodeId); // v5: settlement shares need authorization
  for (const p of ["2", "3", "4"]) attributePlayer(ctx, p, nodeId);
  for (let m = 0; m <= 60; m++) {
    const at = new Date(nowMs + m * 60_000).toISOString();
    ctx.store.append("workshop.heartbeat", `node:${nodeId}`, { nodeId, at, sig: "fixture" }, "public", at);
  }
  nowMs += 120 * 60_000;
  const events = ctx.store.all();
  // A node pulls the same bytes and derives the same settlement.
  const mirrorPath = `${process.env.TMPDIR ?? "/tmp"}/wsettle-${Date.now()}.jsonl`;
  const mirror = new EventStore(mirrorPath);
  const fetchImpl = (async (url: string) => {
    const since = Number(new URL(String(url)).searchParams.get("since") ?? 0);
    return { ok: true, json: async () => events.filter((e) => e.seq > since) };
  }) as unknown as typeof fetch;
  await pullOnce(mirror, mirrorPath, "http://up:8787", fetchImpl);
  const a = deriveSettlement(events, ctx.config, nowMs);
  const b = deriveSettlement(mirror.all(), ctx.config, nowMs);
  assert.deepEqual(b, a);
  assert.equal(a.status, "obligation");
  assert.ok(!JSON.stringify(a).includes("paid"), "never labelled paid");
  const [op] = a.operators;
  assert.equal(op.operatorHandle, "op");
  assert.equal(op.total, 250); // O = 1000 × 0.25, one qualifying node
  const qi = op.nodes[0].payouts.find((p) => p.asset === "qi")!;
  assert.deepEqual(qi.amounts.map((x) => x.date), ["2100-01-08T00:00:00.000Z", "2100-01-15T00:00:00.000Z"]);
  assert.equal(qi.amounts[0].amount! + qi.amounts[1].amount!, 125);
});

test("MCP energy_receipts and settlement carry asOf and closesAt", async () => {
  const ctx = testCtx();
  asPlayer(ctx, "1", "op");
  const { nodeId } = registerTestNode(ctx, "1");
  ctx.store.append("energy.receipt", "system", { nodeId, hour: "2026-11-05T10:00:00.000Z", watts: 65, hoursUp: 1, wh: 65, eventsVerified: 9, requestsServed: 3, heartbeats: 60, source: "s" }, "public");
  for (const [name, args] of [["energy_receipts", { node: nodeId }], ["settlement", {}]] as const) {
    const r: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const env = JSON.parse(r.result.content[0].text);
    assert.deepEqual(Object.keys(env).sort(), ["asOf", "closesAt", "result"]);
  }
  const missing: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "energy_receipts", arguments: { node: "N-9999" } } });
  assert.equal(missing.result.isError, true);
});

test("buildRegistration produces bodies the coordinator accepts", () => {
  const ctx = testCtx();
  asPlayer(ctx, "1", "op");
  const key = testNodeKey();
  const body = buildRegistration(key.sign, { url: "http://n.example", publicKey: key.jwk, energy: testEnergy(), payout: testPayout() });
  const { nodeId } = registerNode(ctx, { operator: "1", ...(body as any) });
  assert.match(nodeId, /^N-\d{4}$/);
});
