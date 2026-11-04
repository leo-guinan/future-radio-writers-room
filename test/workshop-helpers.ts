// Shared workshop test helpers (no tests here; imported by workshop test files).
import assert from "node:assert/strict";
import { EventStore } from "../src/core/events.ts";
import type { WorkshopConfig } from "../src/workshop/config.ts";
import { WorkshopError, addPlayer, type WorkshopCtx } from "../src/workshop/log.ts";
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
      text = JSON.stringify({ error: e.message, code: e.code });
    } else throw e;
  }
  return { status, headers, json: text ? JSON.parse(text) : null, text };
}

export const cookieFor = (xId: string, handle: string) => ({ cookie: `workshop_session=${signSession("test-secret", { xId, handle }, NOW)}` });

export const asPlayer = (ctx: WorkshopCtx, xId: string, handle: string, createdAt = "2020-01-01T00:00:00Z") => {
  addPlayer(ctx, { xId, handle, createdAt });
  return cookieFor(xId, handle);
};
