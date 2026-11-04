import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { EventStore } from "../src/core/events.ts";
import { WorkshopError, addIdea, addPlayer, verifyHeartbeatSig } from "../src/workshop/log.ts";
import { handleMcpMessage } from "../src/workshop/mcp.ts";
import { loadOrCreateNodeKey, parseNodeArgs, pullOnce, sendHeartbeat, verifyPulledEvents } from "../src/workshop/node.ts";
import { workshopRoutes } from "../src/workshop/routes.ts";
import { asPlayer, call, testCtx } from "./workshop-helpers.ts";

const seedUpstream = () => {
  const store = new EventStore(null);
  store.append("workshop.opened", "system", { opensAt: "2026-11-04T09:00:00-05:00", closesAt: "2100-01-01T00:00:00Z" }, "public");
  store.append("workshop.player", "x:1", { xId: "1", handle: "ada", createdAt: "2020-01-01T00:00:00Z" }, "public");
  store.append("workshop.idea", "x:1", { id: "W-0001", author: "1", kind: "game", title: "A", pitch: "p", incentive: "i", createdAt: "2026-11-05T00:00:00Z" }, "public");
  return store;
};

const upstreamFetch = (store: EventStore) =>
  (async (url: string) => {
    const since = Number(new URL(String(url)).searchParams.get("since") ?? 0);
    return { ok: true, json: async () => store.all().filter((e) => e.seq > since) };
  }) as unknown as typeof fetch;

test("node replica pulls a good chain and refuses a broken one", async () => {
  const upstream = seedUpstream();
  const dir = mkdtempSync(join(tmpdir(), "wnode-"));
  const mirrorPath = join(dir, "upstream-events.jsonl");
  const mirror = new EventStore(mirrorPath);
  const added = await pullOnce(mirror, mirrorPath, "http://up:8787", upstreamFetch(upstream));
  assert.equal(added, 3);
  assert.equal(mirror.head, upstream.head);

  // Tampered content upstream: the puller refuses.
  const evil = seedUpstream();
  (evil.all() as any[])[2].payload.title = "HACKED";
  const mirror2 = new EventStore(null);
  await assert.rejects(() => pullOnce(mirror2, join(dir, "m2.jsonl"), "http://up:8787", upstreamFetch(evil)), (e: unknown) => e instanceof WorkshopError && e.code === "chain_unverified");
  assert.equal(mirror2.all().length, 0); // nothing unverified lands locally

  // Out-of-order seq refuses too.
  assert.throws(() => verifyPulledEvents("genesis", 0, [{ ...upstream.all()[1] }] as any), (e: unknown) => e instanceof WorkshopError && e.code === "chain_unverified");
});

test("an unverified node refuses to serve reads", async () => {
  const ctx = testCtx({ mode: "node", upstream: "http://up:8787", verified: () => false });
  const routes = workshopRoutes(ctx);
  const r = await call(routes, "GET", "/api/workshop");
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "chain_unverified");
  const ctxOk = testCtx({ mode: "node", upstream: "http://up:8787", verified: () => true });
  const ok = await call(workshopRoutes(ctxOk), "GET", "/api/workshop");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.mode, "node");
  // Nodes never take writes; auth redirects upstream.
  const w = await call(workshopRoutes(ctxOk), "POST", "/api/workshop/ideas", { body: {} });
  assert.equal(w.status, 403);
  assert.equal(w.json.code, "node_readonly");
  const a = await call(workshopRoutes(ctxOk), "GET", "/api/workshop/auth/x/start");
  assert.equal(a.status, 302);
  assert.equal(a.headers.location, "http://up:8787/api/workshop/auth/x/start");
});

test("node keys persist and heartbeats verify", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wkey-"));
  const k1 = loadOrCreateNodeKey(dir);
  const k2 = loadOrCreateNodeKey(dir);
  assert.deepEqual(k1.publicJwk, k2.publicJwk);
  assert.equal((statSync(join(dir, "workshop", "node-key.json")).mode & 0o777), 0o600);
  let posted: any = null;
  const fetchImpl = (async (_url: string, init: any) => {
    posted = JSON.parse(String(init.body));
    return { ok: true, text: async () => "" };
  }) as unknown as typeof fetch;
  await sendHeartbeat("http://up:8787", "N-0001", k1.sign, Date.parse("2026-11-05T12:00:00Z"), fetchImpl);
  assert.equal(posted.nodeId, "N-0001");
  assert.equal(verifyHeartbeatSig(k1.publicJwk, posted.nodeId, posted.at, posted.sig), true);
});

test("node args parse and reject", () => {
  assert.deepEqual(parseNodeArgs(["--upstream", "http://a:8787/", "--port", "9999", "--node-id", "N-0001"]), { upstream: "http://a:8787", port: 9999, nodeId: "N-0001" });
  assert.throws(() => parseNodeArgs([]), /--upstream/);
  assert.throws(() => parseNodeArgs(["--upstream", "notaurl"]), /--upstream/);
  assert.throws(() => parseNodeArgs(["--upstream", "http://a", "--port", "xx"]), /--port/);
});

test("every MCP tool result carries asOf and closesAt", async () => {
  const ctx = testCtx();
  addPlayer(ctx, { xId: "1", handle: "ada", createdAt: "2020-01-01T00:00:00Z" });
  addIdea(ctx, { author: "1", kind: "game", title: "A", pitch: "p", incentive: "i" });
  const init: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(init.result.serverInfo.name, "art-bus-workshop");
  const list: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = list.result.tools.map((t: any) => t.name);
  for (const n of ["workshop_status", "list_ideas", "get_idea", "scoreboard", "get_player", "rewards", "recent_events", "verify_chain", "list_nodes", "how_to_play"])
    assert.ok(names.includes(n), `tool ${n} listed`);
  const calls: Array<[string, any]> = [
    ["workshop_status", {}],
    ["list_ideas", { sort: "votes", limit: 5 }],
    ["get_idea", { id: "W-0001" }],
    ["scoreboard", {}],
    ["get_player", { handle: "ada" }],
    ["rewards", {}],
    ["recent_events", { since: 0, limit: 10 }],
    ["verify_chain", {}],
    ["list_nodes", {}],
    ["how_to_play", {}],
  ];
  let id = 100;
  for (const [name, args] of calls) {
    const r: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } });
    assert.ok(!r.error, `${name}: ${JSON.stringify(r.error)}`);
    const text = r.result.content[0].text;
    const env = JSON.parse(text);
    assert.deepEqual(Object.keys(env).sort(), ["asOf", "closesAt", "result"]);
    assert.equal(env.asOf.seq, 2);
    assert.ok(env.asOf.time);
    assert.equal(env.closesAt, ctx.config.closesAt);
  }
  const missing: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 999, method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal(missing.error.code, -32602);
  const note = await handleMcpMessage(ctx, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note, null);
});

test("MCP over Streamable HTTP answers through the route table", async () => {
  const ctx = testCtx();
  asPlayer(ctx, "1", "ada");
  const r = await call(workshopRoutes(ctx), "POST", "/mcp", { body: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "workshop_status", arguments: {} } } });
  assert.equal(r.status, 200);
  const env = JSON.parse(r.json.result.content[0].text);
  assert.equal(env.asOf.seq, 1);
  assert.equal(env.closesAt, ctx.config.closesAt);
  assert.equal(env.result.counts.players, 1);
});

test("npx tsx src/workshop/mcp.ts answers workshop_status over stdio", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wmcp-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/workshop/mcp.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stdio MCP timed out. stdout: ${out.slice(0, 500)}`)), 60_000);
    child.stdout.on("data", () => {
      const lines = out.split("\n").filter(Boolean);
      if (lines.length >= 2) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "workshop_status", arguments: {} } })}\n`);
  try {
    await done;
  } finally {
    child.kill("SIGTERM");
  }
  const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const status = lines.find((l) => l.id === 2);
  assert.ok(status, `no reply id 2 in ${out.slice(0, 300)}`);
  const env = JSON.parse(status.result.content[0].text);
  assert.equal(typeof env.asOf.seq, "number");
  assert.ok(env.asOf.time);
  assert.equal(env.closesAt, "2026-11-08T23:59:00-05:00"); // the shipped config
});
