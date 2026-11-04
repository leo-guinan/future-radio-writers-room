import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkshopError, addBuild, addIdea, addPlayer, heartbeatMessage, isClosed, setVotes } from "../src/workshop/log.ts";
import { deriveIdeas, deriveNodes, deriveRewards, deriveScoreboard } from "../src/workshop/derive.ts";
import { authConfigured, signSession, verifySession } from "../src/workshop/auth.ts";
import { workshopRoutes } from "../src/workshop/routes.ts";
import { NOW, asPlayer, call, cookieFor, registerTestNode, signedRegistration, testConfig, testCtx, testNodeKey } from "./workshop-helpers.ts";

test("close is enforced in code at closesAt", async () => {
  const ctx = testCtx({}, { closesAt: "2026-11-04T09:00:01-05:00" }); // already past at NOW
  assert.equal(isClosed(ctx.config, NOW), true);
  const routes = workshopRoutes(ctx);
  const st = await call(routes, "GET", "/api/workshop");
  assert.equal(st.json.open, false);
  assert.equal(st.json.countdownMs, 0);
  const w = await call(routes, "POST", "/api/workshop/ideas", { body: {}, headers: cookieFor("1", "ada") });
  assert.equal(w.status, 409);
  assert.equal(w.json.code, "workshop_closed");
  const v = await call(routes, "PUT", "/api/workshop/votes", { body: {}, headers: cookieFor("1", "ada") });
  assert.equal(v.json.code, "workshop_closed");
  // The close appends one workshop.closed event with snapshot + hash.
  const closed = ctx.store.all().filter((e) => e.type === "workshop.closed");
  assert.equal(closed.length, 1);
  assert.ok(Array.isArray((closed[0].payload as any).scoreboard));
  assert.match(String((closed[0].payload as any).hash), /^[0-9a-f]{64}$/);
  await call(routes, "GET", "/api/workshop"); // second tick appends nothing
  assert.equal(ctx.store.all().filter((e) => e.type === "workshop.closed").length, 1);
});

test("one player per X id", () => {
  const ctx = testCtx();
  addPlayer(ctx, { xId: "1", handle: "ada", createdAt: "2020-01-01T00:00:00Z" });
  assert.throws(() => addPlayer(ctx, { xId: "1", handle: "ada2", createdAt: "2020-01-01T00:00:00Z" }), (e: unknown) => e instanceof WorkshopError && e.code === "duplicate_player");
  addPlayer(ctx, { xId: "2", handle: "grace", createdAt: "2020-01-01T00:00:00Z" });
  assert.equal(ctx.store.all().filter((e) => e.type === "workshop.player").length, 2);
});

test("vote budget: 10 total, at most 5 per idea, reallocation", async () => {
  const ctx = testCtx();
  const routes = workshopRoutes(ctx);
  const ada = asPlayer(ctx, "1", "ada");
  const grace = asPlayer(ctx, "2", "grace");
  const ids: string[] = [];
  for (const h of [ada, ada, grace]) {
    const r = await call(routes, "POST", "/api/workshop/ideas", { body: { kind: "game", title: "t", pitch: "p", incentive: "i" }, headers: h });
    assert.equal(r.status, 201);
    ids.push(r.json.id);
  }
  const ok = await call(routes, "PUT", "/api/workshop/votes", { body: { [ids[0]]: 5, [ids[1]]: 5 }, headers: ada });
  assert.equal(ok.status, 200);
  const over = await call(routes, "PUT", "/api/workshop/votes", { body: { [ids[0]]: 5, [ids[1]]: 5, [ids[2]]: 1 }, headers: ada });
  assert.equal(over.status, 400);
  assert.equal(over.json.code, "vote_budget");
  const cap = await call(routes, "PUT", "/api/workshop/votes", { body: { [ids[0]]: 6 }, headers: ada });
  assert.equal(cap.json.code, "vote_cap");
  const unknown = await call(routes, "PUT", "/api/workshop/votes", { body: { "W-9999": 1 }, headers: ada });
  assert.equal(unknown.json.code, "unknown_idea");
  // Reallocation replaces the whole ballot.
  const move = await call(routes, "PUT", "/api/workshop/votes", { body: { [ids[2]]: 10 - 5, [ids[0]]: 5 }, headers: ada });
  assert.equal(move.status, 200);
  assert.deepEqual(move.json.allocation, { [ids[2]]: 5, [ids[0]]: 5 });
  const ideas = deriveIdeas(ctx.store.all(), ctx.config);
  assert.equal(ideas.find((i) => i.id === ids[1])!.votes, 0);
  assert.equal(ideas.find((i) => i.id === ids[2])!.votes, 5);
});

test("idea limit and verification", async () => {
  const ctx = testCtx();
  const routes = workshopRoutes(ctx);
  const anon = await call(routes, "POST", "/api/workshop/ideas", { body: { kind: "game", title: "t", pitch: "p", incentive: "i" } });
  assert.equal(anon.status, 401);
  const ada = asPlayer(ctx, "1", "ada");
  for (let i = 0; i < 3; i++) {
    const r = await call(routes, "POST", "/api/workshop/ideas", { body: { kind: i % 2 ? "video" : "game", title: `t${i}`, pitch: "p", incentive: "i" }, headers: ada });
    assert.equal(r.status, 201);
  }
  const fourth = await call(routes, "POST", "/api/workshop/ideas", { body: { kind: "game", title: "t3", pitch: "p", incentive: "i" }, headers: ada });
  assert.equal(fourth.status, 400);
  assert.equal(fourth.json.code, "idea_limit");
  const badKind = await call(routes, "POST", "/api/workshop/ideas", { body: { kind: "song", title: "t", pitch: "p", incentive: "i" }, headers: asPlayer(ctx, "2", "grace") });
  assert.equal(badKind.json.code, "bad_idea");
});

test("scores derive from a fixture log", () => {
  const ctx = testCtx();
  // Ada: old account, 1 idea, 7 votes received, built. Grace: new account, 1 idea, 3 votes. Ada also runs a node for 61 heartbeats.
  addPlayer(ctx, { xId: "1", handle: "ada", createdAt: "2020-01-01T00:00:00Z" });
  addPlayer(ctx, { xId: "2", handle: "grace", createdAt: "2026-10-20T00:00:00Z" });
  const a = addIdea(ctx, { author: "1", kind: "game", title: "A", pitch: "p", incentive: "i" });
  const g = addIdea(ctx, { author: "2", kind: "video", title: "G", pitch: "p", incentive: "i" });
  const aid = (a.payload as any).id;
  const gid = (g.payload as any).id;
  setVotes(ctx, "1", { [aid]: 5, [gid]: 3 });
  setVotes(ctx, "2", { [aid]: 2 });
  addBuild(ctx, { ideaId: aid, url: "https://example.com/a", note: "made", by: "producer" });
  const { nodeId } = registerTestNode(ctx, "1");
  // Heartbeats bypass signature here: append raw heartbeat events across 61 distinct minutes.
  for (let m = 0; m < 61; m++) {
    const at = new Date(Date.parse("2026-11-05T00:00:00-05:00") + m * 60_000).toISOString();
    ctx.store.append("workshop.heartbeat", `node:${nodeId}`, { nodeId, at, sig: "fixture" }, "public", at);
  }
  const board = deriveScoreboard(ctx.store.all(), ctx.config);
  assert.equal(board.length, 2);
  const ada = board[0];
  assert.equal(ada.handle, "ada");
  assert.equal(ada.newAccount, false);
  assert.deepEqual(ada.breakdown, { ideas: 1, votes: 7, builds: 25, uptime: 1 });
  assert.equal(ada.points, 34);
  const grace = board[1];
  assert.equal(grace.newAccount, true);
  assert.deepEqual(grace.breakdown, { ideas: 1, votes: 3, builds: 0, uptime: 0 });
  assert.equal(deriveNodes(ctx.store.all(), ctx.config, NOW)[0].upHours, 1);
});

test("chain verification detects a tampered event", () => {
  const ctx = testCtx();
  addPlayer(ctx, { xId: "1", handle: "ada", createdAt: "2020-01-01T00:00:00Z" });
  addIdea(ctx, { author: "1", kind: "game", title: "A", pitch: "p", incentive: "i" });
  const ok = ctx.store.verify();
  assert.equal(ok.ok, true);
  assert.equal((ok as any).count, 2);
  // Tamper with the idea title in place: content no longer matches the hash.
  const events = ctx.store.all() as any[];
  events[1].payload.title = "HACKED";
  const bad = ctx.store.verify();
  assert.equal(bad.ok, false);
  assert.equal((bad as any).at, events[1].id);
});

test("heartbeat signature check", async () => {
  const ctx = testCtx();
  const routes = workshopRoutes(ctx);
  const ada = asPlayer(ctx, "1", "ada");
  const key = testNodeKey();
  const reg = await call(routes, "POST", "/api/workshop/nodes/register", {
    body: signedRegistration(key, "http://node.example:8788"),
    headers: ada,
  });
  assert.equal(reg.status, 201);
  const nodeId = reg.json.nodeId;
  const counts = { eventsVerified: ctx.store.all().length, requestsServed: 4, head: ctx.store.head };
  const at = new Date(NOW).toISOString();
  const sig = key.sign(heartbeatMessage(nodeId, at, counts)).toString("base64");
  const good = await call(routes, "POST", "/api/workshop/nodes/heartbeat", { body: { nodeId, at, sig, ...counts } });
  assert.equal(good.status, 201);
  const forged = await call(routes, "POST", "/api/workshop/nodes/heartbeat", { body: { nodeId, at, sig: Buffer.from("forged").toString("base64"), ...counts } });
  assert.equal(forged.status, 401);
  assert.equal(forged.json.code, "bad_heartbeat");
  // Same signature replayed at a different minute does not verify.
  const replayAt = new Date(NOW + 60_000).toISOString();
  const replay = await call(routes, "POST", "/api/workshop/nodes/heartbeat", { body: { nodeId, at: replayAt, sig, ...counts } });
  assert.equal(replay.json.code, "bad_heartbeat");
  const staleAt = new Date(NOW - 3600_000).toISOString();
  const stale = await call(routes, "POST", "/api/workshop/nodes/heartbeat", {
    body: { nodeId, at: staleAt, sig: key.sign(heartbeatMessage(nodeId, staleAt, counts)).toString("base64"), ...counts },
  });
  assert.equal(stale.json.code, "stale_heartbeat");
  // A head the coordinator never saw is refused.
  const badHead = { ...counts, head: "bogus" };
  const bogus = await call(routes, "POST", "/api/workshop/nodes/heartbeat", {
    body: { nodeId, at, sig: key.sign(heartbeatMessage(nodeId, at, badHead)).toString("base64"), ...badHead },
  });
  assert.equal(bogus.status, 400);
  assert.equal(bogus.json.code, "bad_head");
});

test("reward projection reports a null operator share as not set", () => {
  // v2 superseded the score-based projection: weights now come from workshares
  // and builds, operators from sqrt attribution. Null share still reads "not set".
  const ctx = testCtx();
  addPlayer(ctx, { xId: "1", handle: "ada", createdAt: "2020-01-01T00:00:00Z" });
  addPlayer(ctx, { xId: "2", handle: "grace", createdAt: "2020-01-01T00:00:00Z" });
  const r = deriveRewards(ctx.store.all(), ctx.config, NOW);
  assert.equal(r.status, "projected");
  assert.equal(r.operatorShareOfParticipants, null);
  assert.equal(r.operatorShareNote, "not set");
  assert.equal(r.pools, null); // no R, no share: shares only, no amounts
  assert.ok(r.players.every((s) => s.amount === null));
  assert.ok(r.formula.includes("sqrt(attributed players"));
  assert.deepEqual(r.inputs, { R: null, nextContest: 0.5, operatorShare: null, blockBonus: 10, closesAt: ctx.config.closesAt });
  // With the share set and R known, pools appear and the label flips when won.
  const ctx2 = testCtx({}, { rewardAmount: 1000, pledge: { ...testConfig().pledge, nodeOperatorShareOfParticipants: 0.2, prizeOutcome: "won" } });
  addPlayer(ctx2, { xId: "1", handle: "ada", createdAt: "2020-01-01T00:00:00Z" });
  const r2 = deriveRewards(ctx2.store.all(), ctx2.config, NOW);
  assert.equal(r2.status, "final");
  assert.deepEqual(r2.pools, { R: 1000, P: 500, O: 100, W: 400, nextContest: 500, operatorUnallocated: 100 });
  assert.deepEqual(r2.totals, { players: 0, nodes: 0, nextContest: 500, unallocated: 500, sum: 1000 });
});

test("auth routes return 503 without credentials", async () => {
  const saved = { id: process.env.X_CLIENT_ID, secret: process.env.X_CLIENT_SECRET, cb: process.env.X_CALLBACK_URL, ws: process.env.WORKSHOP_SECRET };
  delete process.env.X_CLIENT_ID;
  delete process.env.X_CLIENT_SECRET;
  delete process.env.X_CALLBACK_URL;
  delete process.env.WORKSHOP_SECRET;
  try {
    assert.equal(authConfigured(), false);
    const routes = workshopRoutes(testCtx());
    const start = await call(routes, "GET", "/api/workshop/auth/x/start");
    assert.equal(start.status, 503);
    assert.equal(start.json.code, "x_auth_not_configured");
    const cb = await call(routes, "GET", "/api/workshop/auth/x/callback?code=x&state=y");
    assert.equal(cb.status, 503);
    assert.equal(cb.json.code, "x_auth_not_configured");
  } finally {
    if (saved.id !== undefined) process.env.X_CLIENT_ID = saved.id;
    if (saved.secret !== undefined) process.env.X_CLIENT_SECRET = saved.secret;
    if (saved.cb !== undefined) process.env.X_CALLBACK_URL = saved.cb;
    if (saved.ws !== undefined) process.env.WORKSHOP_SECRET = saved.ws;
  }
});

test("sessions verify and forgeries fail", () => {
  const c = signSession("test-secret", { xId: "1", handle: "ada" }, NOW);
  const p = verifySession("test-secret", c, NOW);
  assert.equal(p?.xId, "1");
  assert.equal(verifySession("test-secret", `${c}tampered`, NOW), null);
  assert.equal(verifySession("wrong-secret", c, NOW), null);
  assert.equal(verifySession("test-secret", c, NOW + 31 * 86_400_000), null); // expired
  assert.equal(verifySession("test-secret", null, NOW), null);
});

test("me returns the session and current ballot", async () => {
  const ctx = testCtx();
  const routes = workshopRoutes(ctx);
  const anon = await call(routes, "GET", "/api/workshop/me");
  assert.equal(anon.status, 401);
  const ada = asPlayer(ctx, "1", "ada");
  const idea = await call(routes, "POST", "/api/workshop/ideas", { body: { kind: "game", title: "t", pitch: "p", incentive: "i" }, headers: ada });
  await call(routes, "PUT", "/api/workshop/votes", { body: { [idea.json.id]: 3 }, headers: ada });
  const me = await call(routes, "GET", "/api/workshop/me", { headers: ada });
  assert.equal(me.json.handle, "ada");
  assert.deepEqual(me.json.votes, { [idea.json.id]: 3 });
});

test("builds need the producer token and a real idea", async () => {
  const ctx = testCtx();
  const routes = workshopRoutes(ctx);
  asPlayer(ctx, "1", "ada");
  const idea = await call(routes, "POST", "/api/workshop/ideas", { body: { kind: "game", title: "t", pitch: "p", incentive: "i" }, headers: cookieFor("1", "ada") });
  const anon = await call(routes, "POST", "/api/workshop/builds", { body: { ideaId: idea.json.id, url: "https://x.example", note: "n" } });
  assert.equal(anon.status, 401);
  const ghost = await call(routes, "POST", "/api/workshop/builds", {
    body: { ideaId: "W-9999", url: "https://x.example", note: "n" },
    headers: { authorization: "Bearer prod-token" },
  });
  assert.equal(ghost.json.code, "unknown_idea");
  const ok = await call(routes, "POST", "/api/workshop/builds", {
    body: { ideaId: idea.json.id, url: "https://x.example/vid", note: "made" },
    headers: { authorization: "Bearer prod-token" },
  });
  assert.equal(ok.status, 201);
  assert.throws(() => addBuild(ctx, { ideaId: idea.json.id, url: "notaurl", note: "", by: "producer" }), (e: unknown) => e instanceof WorkshopError && e.code === "bad_build");
});

test("ideas list sorts and the player page aggregates", async () => {
  const ctx = testCtx();
  const routes = workshopRoutes(ctx);
  const ada = asPlayer(ctx, "1", "ada");
  const grace = asPlayer(ctx, "2", "grace");
  const first = await call(routes, "POST", "/api/workshop/ideas", { body: { kind: "game", title: "first", pitch: "p", incentive: "i" }, headers: ada });
  const second = await call(routes, "POST", "/api/workshop/ideas", { body: { kind: "video", title: "second", pitch: "p", incentive: "i" }, headers: grace });
  await call(routes, "PUT", "/api/workshop/votes", { body: { [second.json.id]: 4 }, headers: ada });
  const byVotes = await call(routes, "GET", "/api/workshop/ideas?sort=votes");
  assert.deepEqual(byVotes.json.map((i: any) => i.id), [second.json.id, first.json.id]);
  const one = await call(routes, "GET", `/api/workshop/ideas/${second.json.id}`);
  assert.equal(one.json.votes, 4);
  const missing = await call(routes, "GET", "/api/workshop/ideas/W-9999");
  assert.equal(missing.status, 404);
  const player = await call(routes, "GET", "/api/workshop/players/ADA");
  assert.equal(player.json.handle, "ada");
  assert.equal(player.json.points, 1);
  assert.deepEqual(player.json.votes, { [second.json.id]: 4 });
  const ghost = await call(routes, "GET", "/api/workshop/players/nobody");
  assert.equal(ghost.status, 404);
  const badSort = await call(routes, "GET", "/api/workshop/ideas?sort=nope");
  assert.equal(badSort.status, 400);
});
