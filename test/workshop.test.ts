import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { EventStore } from "../src/core/events.ts";
import type { WorkshopConfig } from "../src/workshop/config.ts";
import { WorkshopError, addBuild, addIdea, addPlayer, heartbeatMessage, isClosed, registerNode, setVotes, type WorkshopCtx } from "../src/workshop/log.ts";
import { deriveIdeas, deriveNodes, deriveRewards, deriveScoreboard } from "../src/workshop/derive.ts";
import { authConfigured, signSession, verifySession } from "../src/workshop/auth.ts";
import { workshopRoutes } from "../src/workshop/routes.ts";

const NOW = Date.parse("2026-11-05T12:00:00-05:00");

function testConfig(over: Partial<WorkshopConfig> = {}): WorkshopConfig {
  return {
    opensAt: "2026-11-04T09:00:00-05:00",
    closesAt: "2100-01-01T00:00:00Z",
    publicUrl: "http://localhost:8787",
    points: { idea: 1, voteReceived: 1, built: 25, uptimeHour: 1 },
    voteBudget: 10,
    voteMaxPerIdea: 5,
    ideasPerPlayer: 3,
    newAccountDays: 30,
    heartbeatIntervalSecs: 60,
    heartbeatWindowSecs: 90,
    heartbeatSkewSecs: 900,
    pledge: {
      text: "pledge",
      ifWin: { participants: 0.5, nextContest: 0.5 },
      ifLose: "public debt on Story.markets, repaid from future earnings",
      nodeOperatorShareOfParticipants: null,
      prizeOutcome: "pending",
    },
    ...over,
  };
}

function testCtx(over: Partial<WorkshopCtx> = {}, configOver: Partial<WorkshopConfig> = {}): WorkshopCtx {
  return { store: new EventStore(null), config: testConfig(configOver), now: () => NOW, mode: "coordinator", producerToken: "prod-token", ...over };
}

type RouteTable = ReturnType<typeof workshopRoutes>;

async function call(
  routes: RouteTable,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string>; json: any; text: string }> {
  const route = routes.find(([m, re]) => m === method && re.test(path.split("?")[0]));
  assert.ok(route, `no route ${method} ${path}`);
  const m = path.split("?")[0].match(route[1])!;
  const bodyStr = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const req = {
    method,
    url: path,
    headers: opts.headers ?? {},
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      if (bodyStr) yield Buffer.from(bodyStr);
    },
  } as any;
  let status = 0;
  let headers: Record<string, string> = {};
  let text = "";
  const res = {
    writeHead: (s: number, h: Record<string, string>) => {
      status = s;
      headers = h;
    },
    end: (t?: unknown) => {
      text = String(t ?? "");
    },
  } as any;
  try {
    await route[2](req, res, m);
  } catch (e) {
    if (e instanceof WorkshopError) {
      status = e.status;
      text = JSON.stringify({ error: e.message, code: e.code });
    } else throw e;
  }
  return { status, headers, json: text ? JSON.parse(text) : null, text };
}

process.env.WORKSHOP_SECRET = "test-secret";
const cookieFor = (xId: string, handle: string) => ({ cookie: `workshop_session=${signSession("test-secret", { xId, handle }, NOW)}` });
const asPlayer = (ctx: WorkshopCtx, xId: string, handle: string, createdAt = "2020-01-01T00:00:00Z") => {
  addPlayer(ctx, { xId, handle, createdAt });
  return cookieFor(xId, handle);
};

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
  const { publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const { nodeId } = registerNode(ctx, { operator: "1", url: "http://node.example", publicKey: jwk as any });
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
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const reg = await call(routes, "POST", "/api/workshop/nodes/register", {
    body: { url: "http://node.example:8788", publicKey: publicKey.export({ format: "jwk" }) },
    headers: ada,
  });
  assert.equal(reg.status, 201);
  const nodeId = reg.json.nodeId;
  const at = new Date(NOW).toISOString();
  const sig = sign(null, heartbeatMessage(nodeId, at), privateKey).toString("base64");
  const good = await call(routes, "POST", "/api/workshop/nodes/heartbeat", { body: { nodeId, at, sig } });
  assert.equal(good.status, 201);
  const forged = await call(routes, "POST", "/api/workshop/nodes/heartbeat", { body: { nodeId, at, sig: Buffer.from("forged").toString("base64") } });
  assert.equal(forged.status, 401);
  assert.equal(forged.json.code, "bad_heartbeat");
  // Same signature replayed at a different minute does not verify.
  const replayAt = new Date(NOW + 60_000).toISOString();
  const replay = await call(routes, "POST", "/api/workshop/nodes/heartbeat", { body: { nodeId, at: replayAt, sig } });
  assert.equal(replay.json.code, "bad_heartbeat");
  const stale = await call(routes, "POST", "/api/workshop/nodes/heartbeat", {
    body: { nodeId, at: new Date(NOW - 3600_000).toISOString(), sig: sign(null, heartbeatMessage(nodeId, new Date(NOW - 3600_000).toISOString()), privateKey).toString("base64") },
  });
  assert.equal(stale.json.code, "stale_heartbeat");
});

test("reward projection reports a null operator share as not set", () => {
  const ctx = testCtx();
  addPlayer(ctx, { xId: "1", handle: "ada", createdAt: "2020-01-01T00:00:00Z" });
  addPlayer(ctx, { xId: "2", handle: "grace", createdAt: "2020-01-01T00:00:00Z" });
  addPlayer(ctx, { xId: "3", handle: "bob", createdAt: "2020-01-01T00:00:00Z" });
  const a = addIdea(ctx, { author: "1", kind: "game", title: "A", pitch: "p", incentive: "i" });
  const aid = (a.payload as any).id;
  setVotes(ctx, "2", { [aid]: 5 });
  setVotes(ctx, "3", { [aid]: 4 });
  const r = deriveRewards(ctx.store.all(), ctx.config);
  assert.equal(r.status, "projected");
  assert.equal(r.operatorShareOfParticipants, null);
  assert.equal(r.operatorShareNote, "not set");
  assert.equal(r.operatorPool, null);
  assert.ok(r.splits.every((s) => s.operatorShare === null));
  // Ada: 1 + 9 = 10 points; Grace and Bob: 0. Pro rata over 10.
  assert.deepEqual(r.splits.map((s) => [s.handle, s.points, s.shareOfParticipants]), [["ada", 10, 1], ["bob", 0, 0], ["grace", 0, 0]]);
  // With the share set, operators earn from their pool and the label flips when won.
  const ctx2 = testCtx({}, { pledge: { ...testConfig().pledge, nodeOperatorShareOfParticipants: 0.2, prizeOutcome: "won" } });
  addPlayer(ctx2, { xId: "1", handle: "ada", createdAt: "2020-01-01T00:00:00Z" });
  const r2 = deriveRewards(ctx2.store.all(), ctx2.config);
  assert.equal(r2.status, "final");
  assert.equal(r2.operatorPool, 0.1); // 0.5 participants × 0.2
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
