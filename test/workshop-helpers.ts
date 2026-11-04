// Shared workshop test helpers (no tests here; imported by workshop test files).
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { EventStore } from "../src/core/events.ts";
import type { WorkshopConfig } from "../src/workshop/config.ts";
import { WorkshopError, addPlayer, registrationMessage, registerNode, type WorkshopCtx } from "../src/workshop/log.ts";
import { signSession } from "../src/workshop/auth.ts";
import { workshopRoutes } from "../src/workshop/routes.ts";

process.env.WORKSHOP_SECRET = "test-secret";

export const NOW = Date.parse("2026-11-05T12:00:00-05:00");

export function testConfig(over: Partial<WorkshopConfig> = {}): WorkshopConfig {
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
    blockBonus: 10,
    workshareCapPerDay: 5,
    rewardAmount: null,
    generateCostWorkshares: 3,
    producerNode: { nodeId: "producer", allow: [], maxPlayers: 1, fixedPlayerWeight: 1, operatorWeight: 1 },
    noViaPolicy: "reject",
    validationReserve: 0.05,
    challengeWindowDays: 14,
    auditBountyPoints: 10,
    challengeBountyPoints: 10,
    abuseBountyPoints: 10,
    pretenderBountyPoints: 10,
    attributionBurstThreshold: 20,
    newAccountClusterThreshold: 10,
    registryPublicKey: null,
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

export function testCtx(over: Partial<WorkshopCtx> = {}, configOver: Partial<WorkshopConfig> = {}): WorkshopCtx {
  return { store: new EventStore(null), config: testConfig(configOver), now: () => NOW, mode: "coordinator", producerToken: "prod-token", ...over };
}

export type RouteTable = ReturnType<typeof workshopRoutes>;

/** Call a route-table handler with mock req/res (no sockets). Maps WorkshopError like the servers do. */
export async function call(
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
      text = JSON.stringify({ error: e.message, code: e.code, ...e.details });
    } else throw e;
  }
  return { status, headers, json: text ? JSON.parse(text) : null, text };
}

export const cookieFor = (xId: string, handle: string) => ({ cookie: `workshop_session=${signSession("test-secret", { xId, handle }, NOW)}` });

export const asPlayer = (ctx: WorkshopCtx, xId: string, handle: string, createdAt = "2020-01-01T00:00:00Z") => {
  addPlayer(ctx, { xId, handle, createdAt });
  return cookieFor(xId, handle);
};

export interface TestNodeKey {
  jwk: Record<string, unknown>;
  sign: (msg: Buffer) => Buffer;
}

export function testNodeKey(): TestNodeKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { jwk: publicKey.export({ format: "jwk" }) as unknown as Record<string, unknown>, sign: (msg) => sign(null, msg, privateKey) };
}

export const testEnergy = () => ({ watts: 65, source: "rooftop solar (self-attested)", evidenceUrl: "https://example.com/plug-log", budgetWh: 5000 });
export const testPayout = () => ({ qi: 0.5, quai: 0.3, fiat: 0.2, schedule: "now" });

export function signedRegistration(key: TestNodeKey, url: string, energy = testEnergy(), payout = testPayout(), nodeId?: string) {
  const body = { url, publicKey: key.jwk, energy, payout };
  return { ...body, ...(nodeId ? { nodeId } : {}), sig: key.sign(registrationMessage(body)).toString("base64") };
}

/** Register a node with valid energy, payout and signature. Returns the key for heartbeats. */
export function registerTestNode(ctx: WorkshopCtx, operator: string, url = "http://node.example", nodeId?: string): { key: TestNodeKey; nodeId: string } {
  const key = testNodeKey();
  const { nodeId: assigned } = registerNode(ctx, { operator, ...signedRegistration(key, url, testEnergy(), testPayout(), nodeId) });
  return { key, nodeId: assigned };
}

/** Authorize a node directly on the log (the authorize route's oEmbed path is covered by its own tests). */
export function authorizeTestNode(ctx: WorkshopCtx, nodeId: string, url = "https://x.com/op/status/1"): void {
  ctx.store.append("node.authorized", "system", { nodeId, url, at: new Date(NOW).toISOString() }, "public", new Date(NOW).toISOString());
}

/** A registry keypair: pinned public JWK for config, sign fn for the coordinator ctx. */
export function testRegistryKey(): { publicJwk: Record<string, unknown>; sign: (msg: Buffer) => Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicJwk: publicKey.export({ format: "jwk" }) as unknown as Record<string, unknown>, sign: (msg) => sign(null, msg, privateKey) };
}

/** Mock X token + user endpoints for the OAuth callback path. */
export const xMock = (profile: { id: string; username: string; created_at: string }) =>
  (async (url: string) =>
    String(url).includes("oauth2/token")
      ? { ok: true, json: async () => ({ access_token: "mock-token-never-kept" }) } // # git-secret-ignore (test fixture, not a credential)
      : { ok: true, json: async () => ({ data: profile }) }) as unknown as typeof fetch;

/** Set X env for auth tests; returns a restore function. */
export function setXEnv(): () => void {
  const saved = { id: process.env.X_CLIENT_ID, secret: process.env.X_CLIENT_SECRET, cb: process.env.X_CALLBACK_URL };
  process.env.X_CLIENT_ID = "test-client";
  process.env.X_CLIENT_SECRET = "test-secret";
  process.env.X_CALLBACK_URL = "http://localhost:8787/api/workshop/auth/x/callback";
  return () => {
    if (saved.id === undefined) delete process.env.X_CLIENT_ID;
    else process.env.X_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.X_CLIENT_SECRET;
    else process.env.X_CLIENT_SECRET = saved.secret;
    if (saved.cb === undefined) delete process.env.X_CALLBACK_URL;
    else process.env.X_CALLBACK_URL = saved.cb;
  };
}
