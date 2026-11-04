import { test } from "node:test";
import assert from "node:assert/strict";
import { auditMessage, detectGaming, nodeFingerprint, raiseFlag, resolveFlag, runAudit } from "../src/workshop/log.ts";
import { deriveAudits, deriveFlags, deriveNodes, deriveRewards, deriveSettlementPhase, nodeSuspended, settlementSnapshot } from "../src/workshop/derive.ts";
import { handleMcpMessage } from "../src/workshop/mcp.ts";
import { workshopRoutes } from "../src/workshop/routes.ts";
import { NOW, asPlayer, authorizeTestNode, call, registerTestNode, testConfig, testCtx } from "./workshop-helpers.ts";

const prod = (ctx: ReturnType<typeof testCtx>) => ({ authorization: `Bearer ${ctx.producerToken}` });
const money = () => ({ rewardAmount: 1000, pledge: { ...testConfig().pledge, nodeOperatorShareOfParticipants: 0.2 } });
const oembedMock = (doc: () => unknown) => (async () => ({ ok: true, json: async () => doc() })) as unknown as typeof fetch;
const share = (ctx: ReturnType<typeof testCtx>, player: string, handle: string, i: number) => {
  const url = `https://x.com/${handle}/status/8100${player}${i}`;
  ctx.store.append("workshare.recorded", `x:${player}`, { url, player, handle, tweetId: `8100${player}${i}`, tweetedAt: "2026-11-05T12:00:00Z", day: "2026-11-05", counted: true }, "public");
};

test("recruit authorization needs a matching oEmbed author and the fingerprint", async () => {
  let doc: unknown = {};
  const ctx = testCtx({ fetchImpl: oembedMock(() => doc) });
  const routes = workshopRoutes(ctx);
  const op = asPlayer(ctx, "1", "op");
  const { key, nodeId } = registerTestNode(ctx, "1", "http://n.example");
  const fp = nodeFingerprint(key.jwk);
  const url = "https://x.com/op/status/123";
  doc = { author_url: "https://x.com/mallory", html: `<blockquote>${fp}</blockquote>` };
  const mismatch = await call(routes, "POST", `/api/workshop/nodes/${nodeId}/authorize`, { body: { url }, headers: op });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.json.code, "author_mismatch");
  doc = { author_url: "https://x.com/op", html: "<blockquote>run a node, no fingerprint here</blockquote>" };
  const missing = await call(routes, "POST", `/api/workshop/nodes/${nodeId}/authorize`, { body: { url }, headers: op });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, "missing_fingerprint");
  doc = { author_url: "https://x.com/op", html: `<blockquote>my node key: ${fp}</blockquote>` };
  const ok = await call(routes, "POST", `/api/workshop/nodes/${nodeId}/authorize`, { body: { url }, headers: op });
  assert.equal(ok.status, 201);
  assert.equal(deriveNodes(ctx.store.all(), ctx.config, NOW).find((n) => n.nodeId === nodeId)!.authorized, true);
  const again = await call(routes, "POST", `/api/workshop/nodes/${nodeId}/authorize`, { body: { url }, headers: op });
  assert.equal(again.status, 409);
  const stranger = asPlayer(ctx, "2", "mallory");
  const hijack = await call(routes, "POST", `/api/workshop/nodes/${nodeId}/authorize`, { body: { url }, headers: stranger });
  assert.equal(hijack.status, 403); // only the operator authorizes
});

test("an unauthorized node gets no operator credit", () => {
  let nowMs = Date.parse("2026-11-04T10:00:00-05:00");
  const ctx = testCtx({ now: () => nowMs });
  asPlayer(ctx, "1", "op");
  for (let i = 2; i <= 5; i++) asPlayer(ctx, String(i), `p${i}`);
  const { nodeId } = registerTestNode(ctx, "1", "http://n.example");
  for (let i = 2; i <= 5; i++) ctx.store.append("player.attributed", `x:${i}`, { player: String(i), nodeId }, "public");
  const t0 = nowMs;
  for (let m = 0; m <= 60; m++) {
    const at = new Date(t0 + m * 60_000).toISOString();
    ctx.store.append("workshop.heartbeat", `node:${nodeId}`, { nodeId, at, sig: "fixture" }, "public", at);
  }
  nowMs = t0 + 120 * 60_000;
  const before = deriveNodes(ctx.store.all(), ctx.config, nowMs).find((n) => n.nodeId === nodeId)!;
  assert.equal(before.qualifies, true);
  assert.equal(before.authorized, false);
  assert.equal(before.weight, 0); // uptime and recruits, but no authorization: no credit
  share(ctx, "2", "p2", 0);
  assert.equal(deriveRewards(ctx.store.all(), ctx.config, nowMs).players.find((p) => p.xId === "2")!.weight, 1); // players still earn
  authorizeTestNode(ctx, nodeId);
  assert.equal(deriveNodes(ctx.store.all(), ctx.config, nowMs).find((n) => n.nodeId === nodeId)!.weight, 2); // sqrt(4)
});

test("a failed audit suspends uptime credit, and three in a row suspend the node", async () => {
  let nowMs = Date.parse("2026-11-05T10:00:00Z");
  const ctx = testCtx({ now: () => nowMs });
  asPlayer(ctx, "1", "op");
  const { key, nodeId } = registerTestNode(ctx, "1", "http://n.example");
  authorizeTestNode(ctx, nodeId);
  const beat = (at: string) => ctx.store.append("workshop.heartbeat", `node:${nodeId}`, { nodeId, at, sig: "fixture" }, "public", at);
  beat("2026-11-05T10:05:00Z"); // no audits yet: counts
  const target = ctx.store.all().find((e) => e.seq === 1)!;
  const proof = (hash: string) => ({ nodeId, k: 1, hash, head: ctx.store.head, sig: key.sign(auditMessage(nodeId, 1, hash, ctx.store.head)).toString("base64") });
  let answer = proof("wrong");
  const auditFetch = (async () => ({ ok: true, json: async () => answer })) as unknown as typeof fetch;
  nowMs = Date.parse("2026-11-05T10:10:00Z");
  assert.equal((await runAudit(ctx, nodeId, 1, auditFetch)).pass, false);
  beat("2026-11-05T10:15:00Z"); // latest audit fails: suspended, doesn't count
  assert.equal(deriveNodes(ctx.store.all(), ctx.config, nowMs).find((n) => n.nodeId === nodeId)!.upMinutes, 1);
  assert.equal(nodeSuspended(ctx.store.all(), nodeId), false); // one fail is not suspension
  answer = proof(target.hash);
  nowMs = Date.parse("2026-11-05T10:20:00Z");
  assert.equal((await runAudit(ctx, nodeId, 1, auditFetch)).pass, true);
  beat("2026-11-05T10:25:00Z"); // passing again: counts
  assert.equal(deriveNodes(ctx.store.all(), ctx.config, nowMs).find((n) => n.nodeId === nodeId)!.upMinutes, 2);
  answer = proof("wrong");
  for (const t of ["10:30", "10:40", "10:50"]) {
    nowMs = Date.parse(`2026-11-05T${t}:00Z`);
    assert.equal((await runAudit(ctx, nodeId, 1, auditFetch)).pass, false);
  }
  const suspended = deriveNodes(ctx.store.all(), ctx.config, nowMs).find((n) => n.nodeId === nodeId)!;
  assert.equal(nodeSuspended(ctx.store.all(), nodeId), true);
  assert.equal(suspended.suspended, true);
  assert.equal(suspended.weight, 0); // suspended: no operator credit until it passes again
  answer = proof(target.hash);
  nowMs = Date.parse("2026-11-05T11:00:00Z");
  assert.equal((await runAudit(ctx, nodeId, 1, auditFetch)).pass, true);
  assert.equal(nodeSuspended(ctx.store.all(), nodeId), false);
  assert.equal(deriveAudits(ctx.store.all(), nodeId).map((a) => a.result).join(","), "fail,pass,fail,fail,fail,pass");
});

test("a canary hit raises a flag", async () => {
  const ctx = testCtx();
  const routes = workshopRoutes(ctx);
  const ada = asPlayer(ctx, "1", "ada");
  const decoy = await call(routes, "POST", "/api/workshop/admin/export", { body: {}, headers: ada });
  assert.equal(decoy.status, 404); // the decoy plays dead…
  const flags = await call(routes, "GET", "/api/workshop/flags");
  assert.equal(flags.json.length, 1);
  assert.equal(flags.json[0].signal, "canary:decoy_route");
  assert.ok(flags.json[0].subjectHash && !("subject" in flags.json[0])); // …but the hit is logged, pseudonymous
  const idea = await call(routes, "POST", "/api/workshop/ideas", {
    body: { kind: "game", title: "T", pitch: "p", incentive: "i", website: "http://spam.example" },
    headers: ada,
  });
  assert.equal(idea.status, 201); // the honeypot logs and proceeds
  assert.equal(ctx.store.all().filter((e) => e.type === "flag.raised" && (e.payload as any).signal === "canary:honeypot").length, 1);
});

/** Open fixture, then close it: gameplay first, governance after. */
function closedCtx(over: Parameters<typeof testCtx>[1] = {}) {
  let nowMs = NOW;
  const ctx = testCtx({ now: () => nowMs }, { closesAt: "2026-11-05T18:00:00Z", ...money(), ...over });
  const close = async () => {
    nowMs = Date.parse("2026-11-05T19:00:00Z");
    await call(workshopRoutes(ctx), "GET", "/api/workshop/settlement"); // tick: receipt, close, propose
  };
  const setNow = (iso: string) => (nowMs = Date.parse(iso));
  return { ctx, close, setNow };
}

test("quarantined weight is forfeited and redistributed at finalization, with the bounty paid", async () => {
  const { ctx, close, setNow } = closedCtx();
  const routes = workshopRoutes(ctx);
  asPlayer(ctx, "ada", "ada");
  asPlayer(ctx, "gamer", "gamer");
  const ida = asPlayer(ctx, "ida", "ida");
  share(ctx, "ada", "ada", 0);
  share(ctx, "gamer", "gamer", 0);
  share(ctx, "gamer", "gamer", 1);
  const before = deriveRewards(ctx.store.all(), ctx.config, NOW);
  assert.deepEqual(before.players.map((p) => [p.xId, p.amount]), [["ada", 133.33], ["gamer", 266.67], ["ida", 0]]); // gamer still counts…
  const flag = await call(routes, "POST", "/api/workshop/flags", {
    body: { subject: "gamer", subjectKind: "player", signal: "abuse_report", evidence: { note: "scripted schedule" } },
    headers: ida,
  });
  assert.equal(flag.status, 201);
  const upheld = await call(routes, "POST", `/api/workshop/flags/${flag.json.id}/resolve`, {
    body: { decision: "upheld", note: "Confirmed automation." },
    headers: prod(ctx),
  });
  assert.equal(upheld.status, 201);
  await close();
  setNow("2026-11-25T00:00:00Z"); // past the 14-day window
  const fin = await call(routes, "POST", "/api/workshop/settlement/finalize", { headers: prod(ctx) });
  assert.equal(fin.status, 201);
  const r = deriveRewards(ctx.store.all(), ctx.config, Date.parse("2026-11-25T00:00:00Z"));
  const gamer = r.players.find((p) => p.xId === "gamer")!;
  assert.equal(gamer.quarantined, true);
  assert.equal(gamer.weight, 0);
  assert.equal(gamer.amount, 0); // forfeited
  assert.equal(r.players.find((p) => p.xId === "ada")!.amount, 390); // the whole W split: 375 + 15 unused reserve
  assert.equal(r.players.find((p) => p.xId === "ida")!.bounty, 10); // the reporter's bounty, from V
  assert.deepEqual([r.pools!.V, r.totals!.bounties, r.pools!.reserveUnused], [25, 10, 15]);
  assert.equal(r.totals!.sum, 1000);
});

test("an appeal that clears a flag restores the weight", async () => {
  const ctx = testCtx({}, money());
  const routes = workshopRoutes(ctx);
  const bob = asPlayer(ctx, "bob", "bob");
  share(ctx, "bob", "bob", 0);
  const ev = raiseFlag(ctx, { subject: "bob", subjectKind: "player", signal: "abuse_report", evidence: {} }, "system");
  const id = (ev.payload as any).id as string;
  assert.equal(deriveRewards(ctx.store.all(), ctx.config, NOW).players.find((p) => p.xId === "bob")!.weight, 0);
  const appeal = await call(routes, "POST", `/api/workshop/flags/${id}/appeal`, { body: { reason: "That was me, on my phone." }, headers: bob });
  assert.equal(appeal.status, 201);
  assert.equal(deriveRewards(ctx.store.all(), ctx.config, NOW).players.find((p) => p.xId === "bob")!.weight, 0); // an appeal alone restores nothing
  const flags = await call(routes, "GET", "/api/workshop/flags");
  assert.equal(flags.json[0].status, "appealed");
  assert.equal(flags.json[0].subject, "bob"); // appealed: the subject is named
  const stranger = asPlayer(ctx, "mallory", "mallory");
  const hijack = await call(routes, "POST", `/api/workshop/flags/${id}/appeal`, { body: { reason: "mine" }, headers: stranger });
  assert.equal(hijack.status, 409); // one appeal only (and not yours anyway)
  resolveFlag(ctx, { id, decision: "cleared", note: "Good enough.", by: "producer" });
  const row = deriveRewards(ctx.store.all(), ctx.config, NOW).players.find((p) => p.xId === "bob")!;
  assert.equal(row.quarantined, false);
  assert.equal(row.weight, 1); // cleared: restored
});

test("settlement can't finalize while a challenge is open", async () => {
  const { ctx, close, setNow } = closedCtx();
  const routes = workshopRoutes(ctx);
  const ada = asPlayer(ctx, "ada", "ada");
  await close();
  const filed = await call(routes, "POST", "/api/workshop/challenges", {
    body: { claim: "My workshare is missing.", evidence: "https://x.com/ada/status/1" },
    headers: ada,
  });
  assert.equal(filed.status, 201);
  setNow("2026-11-25T00:00:00Z");
  const fin = await call(routes, "POST", "/api/workshop/settlement/finalize", { headers: prod(ctx) });
  assert.equal(fin.status, 409);
  assert.equal(fin.json.code, "challenges_open");
  const phase = await call(routes, "GET", "/api/workshop/settlement");
  assert.equal(phase.json.phase, "challenged");
  const resolve = await call(routes, "POST", `/api/workshop/challenges/${filed.json.id}/resolve`, {
    body: { decision: "rejected", note: "It is counted; see the log." },
    headers: prod(ctx),
  });
  assert.equal(resolve.json.reproposed, null); // rejected: nothing changes
  const fin2 = await call(routes, "POST", "/api/workshop/settlement/finalize", { headers: prod(ctx) });
  assert.equal(fin2.status, 201);
  assert.equal((await call(routes, "GET", "/api/workshop/settlement")).json.phase, "final");
});

test("an accepted challenge re-proposes the settlement", async () => {
  const { ctx, close } = closedCtx({ challengeBountyPoints: 0 }); // the second accept changes no amount
  const routes = workshopRoutes(ctx);
  const ada = asPlayer(ctx, "ada", "ada");
  asPlayer(ctx, "gamer", "gamer");
  share(ctx, "ada", "ada", 0);
  share(ctx, "gamer", "gamer", 0);
  await close();
  const p1 = (await call(routes, "GET", "/api/workshop/settlement")).json.proposal.hash as string;
  assert.ok(p1);
  const filed = await call(routes, "POST", "/api/workshop/challenges", {
    body: { claim: "gamer is automated.", evidence: "fixed schedule" },
    headers: ada,
  });
  // The challenge is found sound: the flag goes up, then the challenge is accepted…
  const ev = raiseFlag(ctx, { subject: "gamer", subjectKind: "player", signal: "abuse_report", evidence: {}, reporter: "ada" }, "x:ada");
  resolveFlag(ctx, { id: (ev.payload as any).id as string, decision: "upheld", note: "Confirmed.", by: "producer" });
  const resolve = await call(routes, "POST", `/api/workshop/challenges/${filed.json.id}/resolve`, {
    body: { decision: "accepted", note: "Weight quarantined; re-proposing." },
    headers: prod(ctx),
  });
  assert.ok(resolve.json.reproposed && resolve.json.reproposed !== p1); // …and amounts changed, so a new proposal
  const phase = (await call(routes, "GET", "/api/workshop/settlement")).json;
  assert.equal(phase.proposal.hash, resolve.json.reproposed);
  // An accepted challenge that changes nothing re-proposes nothing.
  const filed2 = await call(routes, "POST", "/api/workshop/challenges", { body: { claim: "note this", evidence: "x" }, headers: ada });
  const resolve2 = await call(routes, "POST", `/api/workshop/challenges/${filed2.json.id}/resolve`, {
    body: { decision: "accepted", note: "Noted; amounts unchanged." },
    headers: prod(ctx),
  });
  assert.equal(resolve2.json.reproposed, null);
  assert.equal(ctx.store.all().filter((e) => e.type === "settlement.proposed").length, 2);
});

test("finalize is refused before the window ends", async () => {
  const { ctx, close } = closedCtx();
  const routes = workshopRoutes(ctx);
  asPlayer(ctx, "ada", "ada");
  await close();
  const fin = await call(routes, "POST", "/api/workshop/settlement/finalize", { headers: prod(ctx) });
  assert.equal(fin.status, 409);
  assert.equal(fin.json.code, "window_open");
  assert.ok(fin.json.windowEndsAt);
  const phase = (await call(routes, "GET", "/api/workshop/settlement")).json;
  assert.equal(phase.phase, "proposed");
  assert.equal(phase.proposal.windowEndsAt, fin.json.windowEndsAt);
});

test("every amount still sums exactly to R", async () => {
  const { ctx, close, setNow } = closedCtx();
  const routes = workshopRoutes(ctx);
  asPlayer(ctx, "op", "op");
  asPlayer(ctx, "ada", "ada");
  asPlayer(ctx, "gamer", "gamer");
  asPlayer(ctx, "ida", "ida");
  const { nodeId } = registerTestNode(ctx, "op", "http://n.example");
  authorizeTestNode(ctx, nodeId);
  ctx.store.append("player.attributed", "x:ada", { player: "ada", nodeId }, "public");
  const t0 = Date.parse("2026-11-05T17:00:00Z"); // registered at NOW (17:00Z); the hour to close is fully up
  for (let m = 0; m < 60; m++) {
    const at = new Date(t0 + m * 60_000).toISOString();
    ctx.store.append("workshop.heartbeat", `node:${nodeId}`, { nodeId, at, sig: "fixture" }, "public", at);
  }
  for (let i = 0; i < 4; i++) share(ctx, "ada", "ada", i);
  for (let i = 0; i < 6; i++) share(ctx, "gamer", "gamer", i);
  const ev = raiseFlag(ctx, { subject: "gamer", subjectKind: "player", signal: "abuse_report", evidence: {}, reporter: "ida" }, "x:ida");
  resolveFlag(ctx, { id: (ev.payload as any).id as string, decision: "upheld", note: "Scripts.", by: "producer" });
  await close();
  setNow("2026-11-25T00:00:00Z");
  const fin = await call(routes, "POST", "/api/workshop/settlement/finalize", { headers: prod(ctx) });
  assert.equal(fin.status, 201);
  const r = deriveRewards(ctx.store.all(), ctx.config, Date.parse("2026-11-25T00:00:00Z"));
  assert.equal(r.players.find((p) => p.xId === "gamer")!.amount, 0);
  assert.equal(r.players.find((p) => p.xId === "ida")!.bounty, 10);
  assert.equal(r.nodes.find((n) => n.nodeId === nodeId)!.amount! > 0, true);
  assert.equal(r.totals!.players + r.totals!.nodes + r.totals!.bounties + r.totals!.nextContest + r.totals!.unallocated, 1000);
  assert.equal(r.totals!.sum, 1000);
  const snap = settlementSnapshot(ctx.store.all(), ctx.config, Date.parse("2026-11-25T00:00:00Z"));
  const fin_ev = ctx.store.all().find((e) => e.type === "settlement.finalized")!;
  assert.equal((fin_ev.payload as any).hash, snap.hash); // the finalized hash re-derives from the log
});

test("bounty claims beyond the reserve split it pro rata", () => {
  const ctx = testCtx({}, { ...money(), abuseBountyPoints: 100 });
  asPlayer(ctx, "ada", "ada");
  asPlayer(ctx, "g", "g");
  asPlayer(ctx, "r1", "r1");
  asPlayer(ctx, "r2", "r2");
  share(ctx, "ada", "ada", 0);
  for (const [i, reporter] of (["r1", "r2"] as const).entries()) {
    const ev = raiseFlag(ctx, { subject: `v${i}`, subjectKind: "player", signal: "abuse_report", evidence: {}, reporter }, `x:${reporter}`);
    resolveFlag(ctx, { id: (ev.payload as any).id as string, decision: "upheld", note: "x", by: "producer" });
  }
  const r = deriveRewards(ctx.store.all(), ctx.config, NOW);
  assert.equal(r.pools!.V, 25);
  assert.deepEqual([r.players.find((p) => p.xId === "r1")!.bounty, r.players.find((p) => p.xId === "r2")!.bounty], [12.5, 12.5]);
  assert.equal(r.pools!.reserveUnused, 0);
  assert.equal(r.totals!.sum, 1000);
});

test("a confirmed peer audit logs the failure and earns the bounty", async () => {
  const ctx = testCtx({}, money());
  const routes = workshopRoutes(ctx);
  asPlayer(ctx, "op", "op");
  const op = asPlayer(ctx, "rep", "rep");
  const { key: targetKey, nodeId: target } = registerTestNode(ctx, "op", "http://t.example");
  const { nodeId: reporter } = registerTestNode(ctx, "rep", "http://r.example");
  const k = ctx.store.all()[0].seq;
  const head = ctx.store.head;
  const wrongSig = targetKey.sign(auditMessage(target, k, "lies", head)).toString("base64");
  const r = await call(routes, "POST", "/api/workshop/audits", {
    body: { reporterNode: reporter, target, k, hash: "lies", head, sig: wrongSig },
    headers: op,
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.confirmed, true);
  const audits = deriveAudits(ctx.store.all(), target);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].result, "fail");
  assert.equal(audits[0].via, "peer");
  assert.equal(deriveRewards(ctx.store.all(), ctx.config, NOW).players.find((p) => p.xId === "rep")!.bounty, 10);
  const forged = await call(routes, "POST", "/api/workshop/audits", {
    body: { reporterNode: reporter, target, k, hash: "lies", head, sig: Buffer.from("forged").toString("base64") },
    headers: op,
  });
  assert.equal(forged.status, 400); // reports must carry the target's own signature
});

test("sign-in bursts and new-account clusters raise flags", () => {
  const ctx = testCtx({}, { attributionBurstThreshold: 3, newAccountClusterThreshold: 2 });
  asPlayer(ctx, "op", "op");
  const { nodeId } = registerTestNode(ctx, "op", "http://n.example");
  for (let i = 0; i < 4; i++) {
    asPlayer(ctx, `new${i}`, `new${i}`, "2026-11-05T12:00:00Z"); // created after opensAt
    ctx.store.append("player.attributed", `x:new${i}`, { player: `new${i}`, nodeId }, "public", new Date(NOW).toISOString());
  }
  const raised = ctx.store.all().filter((e) => e.type === "flag.raised");
  assert.equal(raised.length, 0); // detection runs on the tick, not on write
  detectGaming(ctx);
  const signals = deriveFlags(ctx.store.all()).map((f) => f.signal).sort();
  assert.deepEqual(signals, ["attribution_burst", "new_account_cluster"]);
  detectGaming(ctx); // idempotent while active
  assert.equal(deriveFlags(ctx.store.all()).length, 2);
});

test("MCP audits, flags, challenges and settlement carry asOf and closesAt", async () => {
  const ctx = testCtx();
  asPlayer(ctx, "1", "ada");
  const { nodeId } = registerTestNode(ctx, "1");
  ctx.store.append("node.audit", "system", { nodeId, result: "pass", k: 1, via: "coordinator", at: new Date(NOW).toISOString() }, "public");
  raiseFlag(ctx, { subject: "1", subjectKind: "player", signal: "abuse_report", evidence: {} }, "system");
  for (const [name, args] of [["audits", { node: nodeId }], ["flags", {}], ["challenges", {}], ["settlement", {}]] as const) {
    const r: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const env = JSON.parse(r.result.content[0].text);
    assert.deepEqual(Object.keys(env).sort(), ["asOf", "closesAt", "result"]);
  }
  const phase: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "settlement", arguments: {} } });
  assert.equal(JSON.parse(phase.result.content[0].text).result.phase, "open");
  const names: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 3, method: "tools/list" });
  for (const n of ["audits", "flags", "challenges"]) assert.ok(names.result.tools.some((t: any) => t.name === n));
});
