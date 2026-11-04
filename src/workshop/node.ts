// Volunteer node replica. Pulls the workshop log from upstream, verifies the
// hash chain before serving anything, serves the read API + MCP, and sends a
// signed heartbeat every 60 s. Writes and auth redirect to the coordinator.
//
// Run: npm run workshop:node -- --upstream http://localhost:8787 [--port 8788]

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { EventStore, sha256, canonical } from "../core/events.ts";
import type { RoomEvent } from "../core/types.ts";
import { loadWorkshopConfig } from "./config.ts";
import { WorkshopError, heartbeatMessage, type WorkshopCtx } from "./log.ts";
import { workshopRoutes } from "./routes.ts";

export interface NodeOptions {
  upstream: string;
  port: number;
  dataDir: string;
  nodeId?: string;
  publicPath: string;
}

export const parseNodeArgs = (argv: string[]): Pick<NodeOptions, "upstream" | "port" | "nodeId"> => {
  let upstream = "";
  let port = 8788;
  let nodeId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--upstream") upstream = argv[++i] ?? "";
    else if (argv[i] === "--port") port = Number(argv[++i]);
    else if (argv[i] === "--node-id") nodeId = argv[++i];
  }
  if (!/^https?:\/\//.test(upstream)) throw new Error("Usage: npm run workshop:node -- --upstream <coordinator url> [--port N] [--node-id N-0001]");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("--port must be 1–65535.");
  return { upstream: upstream.replace(/\/$/, ""), port, nodeId };
};

/** Verify pulled events continue this chain: seq, prev linkage, content hash. */
export function verifyPulledEvents(head: string, seq: number, pulled: RoomEvent[]): void {
  let prev = head;
  let n = seq;
  for (const e of pulled) {
    if (e.seq !== n + 1) throw new WorkshopError("chain_unverified", `Upstream event out of order at seq ${e.seq} (want ${n + 1}).`, 503);
    if (e.prev !== prev) throw new WorkshopError("chain_unverified", `Upstream prev hash breaks at ${e.id}.`, 503);
    const { hash, ...rest } = e;
    if (sha256(e.prev + canonical(rest)) !== hash)
      throw new WorkshopError("chain_unverified", `Upstream event ${e.id} content does not match its hash.`, 503);
    prev = hash;
    n = e.seq;
  }
}

export async function pullOnce(store: EventStore, mirrorPath: string, upstream: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<number> {
  const since = store.all().length;
  const res = await fetchImpl(`${upstream}/api/workshop/events?since=${since}`);
  if (!res.ok) throw new Error(`Upstream pull failed: HTTP ${res.status}`);
  const pulled = (await res.json()) as RoomEvent[];
  if (!Array.isArray(pulled)) throw new Error("Upstream returned no event array.");
  verifyPulledEvents(store.head, since, pulled);
  if (pulled.length) {
    mkdirSync(dirname(mirrorPath), { recursive: true });
    appendFileSync(mirrorPath, pulled.map((e) => JSON.stringify(e)).join("\n") + "\n");
    store.sync();
    const v = store.verify();
    if (!v.ok) throw new WorkshopError("chain_unverified", `Local mirror failed verification at ${(v as any).at}.`, 503);
  }
  return pulled.length;
}

const KEY_PATH = (dataDir: string) => join(dataDir, "workshop", "node-key.json");

/** Load or create the node's Ed25519 keypair (persisted 0600). */
export function loadOrCreateNodeKey(dataDir: string): { publicJwk: Record<string, unknown>; sign: (msg: Buffer) => Buffer } {
  const path = KEY_PATH(dataDir);
  let jwk: any;
  if (existsSync(path)) {
    jwk = JSON.parse(readFileSync(path, "utf8"));
  } else {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    jwk = { public: publicKey.export({ format: "jwk" }), private: privateKey.export({ format: "jwk" }) };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(jwk), { mode: 0o600 });
  }
  const priv = createPrivateKey({ key: jwk.private, format: "jwk" });
  return { publicJwk: jwk.public, sign: (msg: Buffer) => sign(null, msg, priv) };
}

export async function sendHeartbeat(upstream: string, nodeId: string, signFn: (msg: Buffer) => Buffer, nowMs: number, fetchImpl: typeof fetch = globalThis.fetch): Promise<void> {
  const at = new Date(nowMs).toISOString();
  const sig = signFn(heartbeatMessage(nodeId, at)).toString("base64");
  const res = await fetchImpl(`${upstream}/api/workshop/nodes/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId, at, sig }),
  });
  if (!res.ok) throw new Error(`Heartbeat refused: HTTP ${res.status} ${String(await res.text().catch(() => "")).slice(0, 160)}`);
}

export async function startNode(opts: NodeOptions, fetchImpl: typeof fetch = globalThis.fetch) {
  const store = new EventStore(join(opts.dataDir, "workshop", "upstream-events.jsonl"));
  const config = loadWorkshopConfig();
  let verified = false;
  const ctx: WorkshopCtx = {
    store,
    config,
    now: () => Date.now(),
    mode: "node",
    upstream: opts.upstream,
    nodeId: opts.nodeId,
    producerToken: "",
    verified: () => verified,
  };
  const routes = workshopRoutes(ctx); // same table; node mode refuses writes and redirects auth upstream

  const pull = async (initial: boolean) => {
    try {
      const added = await pullOnce(store, join(opts.dataDir, "workshop", "upstream-events.jsonl"), opts.upstream, fetchImpl);
      if (!verified) {
        verified = true;
        console.log(`node: upstream chain verified (${store.all().length} events, head ${store.head.slice(0, 12)}). Serving.`);
      } else if (added) console.log(`node: pulled ${added} event(s), head ${store.head.slice(0, 12)}.`);
    } catch (e: any) {
      if (e instanceof WorkshopError && e.code === "chain_unverified") {
        verified = false; // a broken chain revokes serving immediately
        console.error(`node: REFUSING TO SERVE: ${e.message}`);
      } else if (initial) throw e;
      else console.error(`node: pull failed (${e?.message ?? e}); serving last verified log.`);
    }
  };
  await pull(true); // throws on first failure: never serve an unverified chain

  const key = loadOrCreateNodeKey(opts.dataDir);
  if (!opts.nodeId) {
    console.log("node: no --node-id. Register this node at the coordinator (POST /api/workshop/nodes/register) with public key:");
    console.log(`node: ${JSON.stringify(key.publicJwk)}`);
  }
  const beat = async () => {
    if (!opts.nodeId) return;
    try {
      await sendHeartbeat(opts.upstream, opts.nodeId, key.sign, Date.now(), fetchImpl);
    } catch (e: any) {
      console.error(`node: heartbeat failed: ${e?.message ?? e}`);
    }
  };
  const pullTimer = setInterval(() => void pull(false), 15_000);
  const beatTimer = setInterval(() => void beat(), config.heartbeatIntervalSecs * 1000);
  void beat();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      for (const [method, re, h] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) return await h(req, res, m);
      }
      if (req.method === "GET" && (url.pathname === "/workshop" || url.pathname === "/workshop.js")) {
        const file = join(opts.publicPath, url.pathname === "/workshop" ? "workshop.html" : "workshop.js");
        if (!existsSync(file)) {
          res.writeHead(404, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "Not found" }));
        }
        res.writeHead(200, { "content-type": url.pathname === "/workshop" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8" });
        return res.end(readFileSync(file));
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (e) {
      if (e instanceof WorkshopError) {
        res.writeHead(e.status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: e.message, code: e.code }));
      }
      console.error(e);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "The radio crackled. Try again." }));
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  console.log(`workshop node on http://localhost:${opts.port} (upstream ${opts.upstream}${opts.nodeId ? `, ${opts.nodeId}` : ""})`);
  return { server, ctx, stop: () => (clearInterval(pullTimer), clearInterval(beatTimer), server.close()) };
}

if (process.argv[1]?.endsWith("workshop/node.ts")) {
  const args = parseNodeArgs(process.argv.slice(2));
  startNode({ ...args, dataDir: process.env.DATA_DIR ?? join(process.cwd(), "data"), publicPath: join(process.cwd(), "public") }).catch((e) => {
    console.error(`node: ${e?.message ?? e}`);
    process.exit(1);
  });
}
