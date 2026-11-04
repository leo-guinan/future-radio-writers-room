import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkshopError, nodeFingerprint, registryMessage, verifyNodeSig } from "../src/workshop/log.ts";
import { deriveNodes, derivePretenders, deriveReferees, deriveRewards } from "../src/workshop/derive.ts";
import { handleMcpMessage } from "../src/workshop/mcp.ts";
import { fetchVerifiedRegistry } from "../src/workshop/node.ts";
import { workshopRoutes } from "../src/workshop/routes.ts";
import { NOW, asPlayer, authorizeTestNode, call, registerTestNode, testConfig, testCtx, testRegistryKey } from "./workshop-helpers.ts";
import { attributePlayer } from "../src/workshop/log.ts";

const prod = (ctx: ReturnType<typeof testCtx>) => ({ authorization: `Bearer ${ctx.producerToken}` });
const money = () => ({ rewardAmount: 1000, pledge: { ...testConfig().pledge, nodeOperatorShareOfParticipants: 0.2 } });
const oembedMock = (doc: () => unknown) => (async () => ({ ok: true, json: async () => doc() })) as unknown as typeof fetch;

test("a registry with a bad signature is refused by nodes", async () => {
  const key = testRegistryKey();
  const ctx = testCtx({ registrySign: key.sign }, { registryPublicKey: key.publicJwk });
  asPlayer(ctx, "1", "op");
  const { nodeId } = registerTestNode(ctx, "1", "http://n.example");
  authorizeTestNode(ctx, nodeId);
  const routes = workshopRoutes(ctx);
  const reg = await call(routes, "GET", "/api/workshop/referees");
  assert.equal(reg.status, 200);
  assert.equal(reg.json.entries.length, 1);
  assert.equal(verifyNodeSig(key.publicJwk, registryMessage(reg.json.entries, reg.json.seq), reg.json.signature), true);
  const goodFetch = (async () => ({ ok: true, json: async () => reg.json })) as unknown as typeof fetch;
  assert.deepEqual(await fetchVerifiedRegistry("http://up:8787", key.publicJwk, goodFetch), reg.json);
  const evilKey = testRegistryKey();
  const forged = { ...reg.json, signature: evilKey.sign(registryMessage(reg.json.entries, reg.json.seq)).toString("base64") };
  const forgedFetch = (async () => ({ ok: true, json: async () => forged })) as unknown as typeof fetch;
  const badSig = (e: unknown) => e instanceof WorkshopError && e.code === "registry_bad_signature";
  await assert.rejects(() => fetchVerifiedRegistry("http://up:8787", key.publicJwk, forgedFetch), badSig);
  const tampered = { ...reg.json, entries: [] };
  const tamperedFetch = (async () => ({ ok: true, json: async () => tampered })) as unknown as typeof fetch;
  await assert.rejects(() => fetchVerifiedRegistry("http://up:8787", key.publicJwk, tamperedFetch), badSig);
  // A node serves only a verified mirror: nothing cached, nothing served.
  const nodeCtx = testCtx({ mode: "node", upstream: "http://up:8787", verified: () => true });
  const missing = await call(workshopRoutes(nodeCtx), "GET", "/api/workshop/referees");
  assert.equal(missing.status, 503);
  nodeCtx.registryCache = reg.json;
  const served = await call(workshopRoutes(nodeCtx), "GET", "/api/workshop/referees");
  assert.equal(served.status, 200);
  assert.deepEqual(served.json, reg.json);
});

test("check returns each of the four statuses, with evidence", async () => {
  const ctx = testCtx();
  const routes = workshopRoutes(ctx);
  asPlayer(ctx, "a", "ann");
  asPlayer(ctx, "b", "bob");
  asPlayer(ctx, "c", "cy");
  const { key: keyA, nodeId: a } = registerTestNode(ctx, "a", "http://a.example");
  const { nodeId: b } = registerTestNode(ctx, "b", "http://b.example");
  const { nodeId: c } = registerTestNode(ctx, "c", "http://c.example");
  authorizeTestNode(ctx, a, "https://x.com/ann/status/1");
  authorizeTestNode(ctx, b, "https://x.com/bob/status/2");
  authorizeTestNode(ctx, c, "https://x.com/cy/status/3");
  for (let i = 0; i < 3; i++) {
    ctx.store.append("node.audit", "system", { nodeId: b, result: "fail", k: 1, via: "coordinator", at: new Date(NOW + i * 1000).toISOString() }, "public");
  }
  const revoked = await call(routes, "POST", `/api/workshop/nodes/${c}/revoke`, { body: { reason: "Key leaked." }, headers: prod(ctx) });
  assert.equal(revoked.status, 201);
  const check = async (q: string) => (await call(routes, "GET", `/api/workshop/referees/check?q=${encodeURIComponent(q)}`)).json;
  assert.deepEqual(await check(a), {
    q: a,
    status: "AUTHORIZED",
    reason: "Authorized recruiter with passing audits.",
    entry: (await check(a)).entry,
    evidence: { authorizedBy: "https://x.com/ann/status/1", lastPass: null, passRate24h: null },
  });
  const byHandle = await check("BOB");
  assert.equal(byHandle.status, "SUSPENDED");
  assert.match(byHandle.reason, /audit/);
  assert.equal(byHandle.evidence.authorizedBy, "https://x.com/bob/status/2");
  const byFp = await check(nodeFingerprint(keyA.jwk));
  assert.equal(byFp.status, "AUTHORIZED");
  const byUrl = await check("http://a.example");
  assert.equal(byUrl.status, "AUTHORIZED");
  assert.equal(byUrl.entry.nodeId, a);
  const gone = await check(c);
  assert.equal(gone.status, "REVOKED");
  assert.match(gone.reason, /Key leaked/);
  const stranger = await check("mallory");
  assert.equal(stranger.status, "NOT_AUTHORIZED");
  assert.equal(stranger.entry, null);
  // MCP agrees, inside the standard envelope.
  const mcp: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_referee", arguments: { q: "ann" } } });
  const env = JSON.parse(mcp.result.content[0].text);
  assert.deepEqual(Object.keys(env).sort(), ["asOf", "closesAt", "result"]);
  assert.equal(env.result.status, "AUTHORIZED");
  // Suspension and revocation end operator credit.
  assert.equal(deriveNodes(ctx.store.all(), ctx.config, NOW).find((n) => n.nodeId === b)!.suspended, true);
  assert.equal(deriveReferees(ctx.store.all(), ctx.config, NOW).map((e) => e.status).join(","), "authorized,suspended,revoked"); // by nodeId
});

test("a pretender report is confirmed only when the author is not in the registry", async () => {
  let doc: unknown = {};
  const ctx = testCtx({ fetchImpl: oembedMock(() => doc) });
  const routes = workshopRoutes(ctx);
  const op = asPlayer(ctx, "op", "op");
  const ida = asPlayer(ctx, "ida", "ida");
  const { nodeId } = registerTestNode(ctx, "op", "http://n.example");
  authorizeTestNode(ctx, nodeId);
  doc = { author_url: "https://x.com/op", html: "<blockquote>I run a validator node, follow me</blockquote>" };
  const real = await call(routes, "POST", "/api/workshop/pretenders", { body: { url: "https://x.com/op/status/1" }, headers: ida });
  assert.equal(real.status, 200);
  assert.deepEqual([real.json.confirmed, real.json.reason], [false, "authorized_referee"]);
  doc = { author_url: "https://x.com/mallory", html: "<blockquote>validator here, delegate everything</blockquote>" };
  const fake = await call(routes, "POST", "/api/workshop/pretenders", { body: { url: "https://x.com/mallory/status/9" }, headers: ida });
  assert.equal(fake.status, 201);
  assert.equal(fake.json.confirmed, true);
  assert.equal(ctx.store.all().filter((e) => e.type === "pretender.confirmed").length, 1);
  const list = await call(routes, "GET", "/api/workshop/pretenders");
  assert.deepEqual(list.json, [{ url: "https://x.com/mallory/status/9", authorHash: list.json[0].authorHash, reportedAt: list.json[0].reportedAt, status: "not an authorized referee" }]);
  doc = { author_url: "https://x.com/mallory", html: "<blockquote>nice video!</blockquote>" };
  const noclaim = await call(routes, "POST", "/api/workshop/pretenders", { body: { url: "https://x.com/mallory/status/10" }, headers: op });
  assert.deepEqual([noclaim.json.confirmed, noclaim.json.reason], [false, "no_claim"]);
});

test("the bounty is paid from the reserve", async () => {
  const ctx = testCtx({ fetchImpl: oembedMock(() => ({ author_url: "https://x.com/mallory", html: "referee services here" })) }, money());
  const routes = workshopRoutes(ctx);
  const ida = asPlayer(ctx, "ida", "ida");
  const r = await call(routes, "POST", "/api/workshop/pretenders", { body: { url: "https://x.com/mallory/status/9" }, headers: ida });
  assert.equal(r.json.confirmed, true);
  const rewards = deriveRewards(ctx.store.all(), ctx.config, NOW);
  assert.equal(rewards.players.find((p) => p.xId === "ida")!.bounty, 10); // pretenderBountyPoints, from V
  assert.deepEqual([rewards.pools!.V, rewards.totals!.bounties, rewards.pools!.reserveUnused], [25, 10, 15]);
  assert.equal(rewards.totals!.sum, 1000);
});

test("an unregistered node earns no operator credit", async () => {
  const ctx = testCtx({}, { noViaPolicy: "unassigned" });
  asPlayer(ctx, "newbie", "newbie");
  const op = asPlayer(ctx, "op", "op");
  attributePlayer(ctx, "newbie", "N-9999"); // recruit links at ghosts bind nowhere
  const nodes = deriveNodes(ctx.store.all(), ctx.config, NOW);
  assert.ok(!nodes.some((n) => n.nodeId === "N-9999"));
  const ghost = await call(workshopRoutes(ctx), "POST", "/api/workshop/nodes/N-9999/authorize", {
    body: { url: "https://x.com/x/status/1" },
    headers: op,
  });
  assert.equal(ghost.status, 404);
});

test("a pretender who becomes authorized is cleared", async () => {
  const ctx = testCtx({ fetchImpl: oembedMock(() => ({ author_url: "https://x.com/mallory", html: "official validator node" })) });
  const routes = workshopRoutes(ctx);
  const ida = asPlayer(ctx, "ida", "ida");
  const mallory = asPlayer(ctx, "mallory", "mallory");
  const url = "https://x.com/mallory/status/9";
  const r = await call(routes, "POST", "/api/workshop/pretenders", { body: { url }, headers: ida });
  assert.equal(r.json.confirmed, true);
  // Mallory goes legit: run a node, post the fingerprint, then appeal.
  const { nodeId } = registerTestNode(ctx, "mallory", "http://m.example");
  authorizeTestNode(ctx, nodeId);
  const flagId = (ctx.store.all().find((e) => e.type === "flag.raised" && (e.payload as any).signal === "pretender_claim")!.payload as any).id as string;
  const appeal = await call(routes, "POST", `/api/workshop/flags/${flagId}/appeal`, { body: { reason: "I run an authorized node now." }, headers: mallory });
  assert.equal(appeal.status, 201);
  assert.equal(derivePretenders(ctx.store.all())[0].status, "cleared");
  assert.equal((await call(routes, "GET", "/api/workshop/pretenders")).json[0].status, "cleared");
});
