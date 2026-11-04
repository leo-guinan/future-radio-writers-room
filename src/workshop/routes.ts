// Workshop HTTP API in the server's route-table shape. The coordinator mounts
// these with mode "coordinator"; a node replica mounts the same table with mode
// "node" (writes refuse with 403, auth redirects upstream).

import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  WorkshopError,
  addBuild,
  addHeartbeat,
  addIdea,
  addPlayer,
  assertCoordinator,
  assertOpen,
  assertServing,
  hasPlayer,
  maybeClose,
  registerNode,
  setVotes,
  type WorkshopCtx,
} from "./log.ts";
import { deriveIdeas, deriveNodes, derivePlayers, deriveRewards, deriveScoreboard, deriveStatus, deriveVotes } from "./derive.ts";
import { authConfigured, authEnv, beginAuth, requestSession, sessionCookieHeader, signSession, takeVerifier, verifyCode } from "./auth.ts";
import { mcpHttpHandler } from "./mcp.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => Promise<void> | void;

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage, max = 16_000): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new WorkshopError("request_too_large", "Request too large.", 413);
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WorkshopError("bad_json", "Body must be JSON.", 400);
  }
}

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

function isProducer(ctx: WorkshopCtx, req: IncomingMessage): boolean {
  if (!ctx.producerToken) return false;
  const got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(ctx.producerToken);
  return got.length === want.length && timingSafeEqual(got, want);
}

const requireSession = (ctx: WorkshopCtx, req: IncomingMessage): { xId: string; handle: string } => {
  const s = requestSession(req, ctx.now());
  if (!s) throw new WorkshopError("auth_required", "Sign in with X first.", 401);
  return s;
};

export function workshopRoutes(ctx: WorkshopCtx): Array<[string, RegExp, Handler]> {
  const tick = () => {
    ctx.store.sync();
    maybeClose(ctx);
  };
  return [
    ["GET", /^\/api\/workshop$/, (_q, res) => {
      tick();
      assertServing(ctx);
      send(res, 200, deriveStatus(ctx));
    }],
    ["GET", /^\/api\/workshop\/ideas$/, (req, res) => {
      tick();
      assertServing(ctx);
      const sort = new URL(req.url ?? "/", "http://x").searchParams.get("sort") ?? "votes";
      if (sort !== "votes" && sort !== "new") throw new WorkshopError("bad_sort", 'sort must be "votes" or "new".', 400);
      const ideas = deriveIdeas(ctx.store.all(), ctx.config);
      ideas.sort((a, b) => (sort === "votes" ? b.votes - a.votes || a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)));
      send(res, 200, ideas);
    }],
    ["GET", /^\/api\/workshop\/ideas\/([^/]+)$/, (_q, res, m) => {
      tick();
      assertServing(ctx);
      const idea = deriveIdeas(ctx.store.all(), ctx.config).find((i) => i.id === m[1]);
      if (!idea) throw new WorkshopError("unknown_idea", `No idea ${m[1]}.`, 404);
      send(res, 200, idea);
    }],
    ["POST", /^\/api\/workshop\/ideas$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      const s = requireSession(ctx, req);
      const b = await body(req);
      const ev = addIdea(ctx, { author: s.xId, kind: String(b.kind ?? ""), title: clip(b.title, 80), pitch: clip(b.pitch, 500), incentive: clip(b.incentive, 200) });
      send(res, 201, { id: (ev.payload as any).id, eventId: ev.id });
    }],
    ["PUT", /^\/api\/workshop\/votes$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      const s = requireSession(ctx, req);
      const b = await body(req);
      const ev = setVotes(ctx, s.xId, b);
      send(res, 200, { voter: s.xId, allocation: (ev.payload as any).allocation, eventId: ev.id });
    }],
    ["GET", /^\/api\/workshop\/scoreboard$/, (_q, res) => {
      tick();
      assertServing(ctx);
      send(res, 200, deriveScoreboard(ctx.store.all(), ctx.config));
    }],
    ["GET", /^\/api\/workshop\/players\/([^/]+)$/, (_q, res, m) => {
      tick();
      assertServing(ctx);
      const handle = decodeURIComponent(m[1]).toLowerCase();
      const players = derivePlayers(ctx.store.all(), ctx.config);
      const player = [...players.values()].find((p) => p.handle.toLowerCase() === handle);
      if (!player) throw new WorkshopError("unknown_player", `No player ${m[1]}.`, 404);
      const board = deriveScoreboard(ctx.store.all(), ctx.config).find((r) => r.xId === player.xId)!;
      const ideas = deriveIdeas(ctx.store.all(), ctx.config).filter((i) => i.author === player.xId);
      const { byVoter } = deriveVotes(ctx.store.all());
      send(res, 200, { ...player, points: board.points, breakdown: board.breakdown, ideas, votes: byVoter.get(player.xId) ?? {} });
    }],
    ["GET", /^\/api\/workshop\/rewards$/, (_q, res) => {
      tick();
      assertServing(ctx);
      send(res, 200, deriveRewards(ctx.store.all(), ctx.config));
    }],
    ["GET", /^\/api\/workshop\/events$/, (req, res) => {
      tick();
      assertServing(ctx);
      const since = Number(new URL(req.url ?? "/", "http://x").searchParams.get("since") ?? 0);
      if (!Number.isInteger(since) || since < 0) throw new WorkshopError("bad_since", "since must be a non-negative event seq.", 400);
      send(res, 200, ctx.store.all().filter((e) => e.seq > since).slice(0, 1000));
    }],
    ["GET", /^\/api\/workshop\/verify$/, (_q, res) => {
      tick();
      assertServing(ctx);
      send(res, 200, ctx.store.verify());
    }],
    ["GET", /^\/api\/workshop\/me$/, (req, res) => {
      tick();
      assertServing(ctx);
      const s = requireSession(ctx, req);
      const { byVoter } = deriveVotes(ctx.store.all());
      send(res, 200, { xId: s.xId, handle: s.handle, votes: byVoter.get(s.xId) ?? {} });
    }],
    ["GET", /^\/api\/workshop\/nodes$/, (_q, res) => {
      tick();
      assertServing(ctx);
      send(res, 200, deriveNodes(ctx.store.all(), ctx.config, ctx.now()));
    }],
    ["POST", /^\/api\/workshop\/nodes\/register$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      const s = requireSession(ctx, req);
      const b = await body(req);
      const { event, nodeId } = registerNode(ctx, { operator: s.xId, url: clip(b.url, 200), publicKey: b.publicKey });
      send(res, 201, { nodeId, eventId: event.id });
    }],
    ["POST", /^\/api\/workshop\/nodes\/heartbeat$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      const b = await body(req);
      const ev = addHeartbeat(ctx, { nodeId: String(b.nodeId ?? ""), at: String(b.at ?? ""), sig: String(b.sig ?? "") });
      send(res, 201, { ok: true, eventId: ev.id });
    }],
    ["POST", /^\/api\/workshop\/builds$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      if (!isProducer(ctx, req)) throw new WorkshopError("producer_required", "Producer token required.", 401);
      const b = await body(req);
      const ev = addBuild(ctx, { ideaId: String(b.ideaId ?? ""), url: clip(b.url, 500), note: clip(b.note, 500), by: "producer" });
      send(res, 201, { ideaId: (ev.payload as any).ideaId, eventId: ev.id });
    }],
    ["GET", /^\/api\/workshop\/auth\/x\/start$/, (req, res) => {
      if (ctx.mode !== "coordinator") {
        res.writeHead(302, { location: `${ctx.upstream}/api/workshop/auth/x/start` });
        return res.end();
      }
      if (!authConfigured()) throw new WorkshopError("x_auth_not_configured", "X sign-in is not configured on this coordinator.", 503);
      const { url } = beginAuth();
      res.writeHead(302, { location: url });
      res.end();
    }],
    ["GET", /^\/api\/workshop\/auth\/x\/callback$/, async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (ctx.mode !== "coordinator") {
        res.writeHead(302, { location: `${ctx.upstream}/api/workshop/auth/x/callback?${url.searchParams.toString()}` });
        return res.end();
      }
      if (!authConfigured()) throw new WorkshopError("x_auth_not_configured", "X sign-in is not configured on this coordinator.", 503);
      tick();
      assertOpen(ctx);
      const verifier = takeVerifier(url.searchParams.get("state") ?? "");
      const code = url.searchParams.get("code") ?? "";
      if (!verifier || !code) throw new WorkshopError("bad_callback", "Sign-in did not complete. Start again.", 400);
      let profile;
      try {
        profile = await verifyCode(code, verifier);
      } catch (e: any) {
        throw new WorkshopError("x_verify_failed", `X verification failed: ${e?.message ?? e}`, 502);
      }
      // Access token already discarded inside verifyCode. One player per X id.
      try {
        addPlayer(ctx, profile);
      } catch (e) {
        if (!(e instanceof WorkshopError && e.code === "duplicate_player")) throw e;
      }
      if (!hasPlayer(ctx.store, profile.xId)) throw new WorkshopError("not_a_player", "Player record missing after verification.", 500);
      const secure = authEnv().callbackUrl.startsWith("https://");
      res.writeHead(302, { location: "/workshop", "set-cookie": sessionCookieHeader(signSession(authEnv().secret, profile, ctx.now()), secure) });
      res.end();
    }],
    ["POST", /^\/mcp$/, mcpHttpHandler(ctx)],
  ];
}
