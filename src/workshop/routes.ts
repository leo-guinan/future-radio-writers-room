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
  addWorkshare,
  appealFlag,
  assertCoordinator,
  assertOpen,
  assertServing,
  attributePlayer,
  auditMessage,
  authorizeNode,
  detectGaming,
  energyReceiptsOf,
  fileChallenge,
  finalizeSettlement,
  hasPlayer,
  maybeClose,
  maybePropose,
  maybeReceipt,
  raiseFlag,
  registerNode,
  reportPeerAudit,
  requestGeneration,
  resolveAttributionTarget,
  resolveChallenge,
  resolveFlag,
  setPayout,
  setVotes,
  subjectHash,
  voidWorkshare,
  type WorkshopCtx,
} from "./log.ts";
import { deriveAudits, deriveChallenges, deriveFlags, deriveIdeas, deriveNodes, derivePlayers, deriveRewards, deriveScoreboard, deriveSettlementPhase, deriveStatus, deriveVotes, deriveWorkshares } from "./derive.ts";
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
    maybeReceipt(ctx); // receipts fix hourly work before anything else reads the log
    maybeClose(ctx);
    maybePropose(ctx); // at close the settlement is proposed, with its hash
    detectGaming(ctx); // bursts, clusters, and audit-fail growth raise flags
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
      if (typeof b.website === "string" && b.website.trim()) {
        // Canary: the page hides this field, so only automation fills it in. Log and proceed.
        raiseFlag(ctx, { subject: s.xId, subjectKind: "player", signal: "canary:honeypot", evidence: { field: "website" } }, "system");
      }
      const ev = addIdea(ctx, { author: s.xId, kind: String(b.kind ?? ""), title: clip(b.title, 80), pitch: clip(b.pitch, 500), incentive: clip(b.incentive, 200) });
      send(res, 201, { id: (ev.payload as any).id, eventId: ev.id });
    }],
    ["POST", /^\/api\/workshop\/admin\/export$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      // Canary: a decoy, unlisted route that only scraped code would call. Log the hit, play dead.
      const s = requestSession(req, ctx.now());
      const ip = String((req.socket as any)?.remoteAddress ?? "unknown");
      raiseFlag(ctx, { subject: s ? s.xId : `anon:${subjectHash(ip)}`, subjectKind: "player", signal: "canary:decoy_route", evidence: { route: "/api/workshop/admin/export" } }, "system");
      throw new WorkshopError("not_found", "Not found.", 404);
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
      send(res, 200, deriveRewards(ctx.store.all(), ctx.config, ctx.now()));
    }],
    ["POST", /^\/api\/workshop\/workshares$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      const s = requireSession(ctx, req);
      const b = await body(req);
      const r = await addWorkshare(ctx, { player: s.xId, handle: s.handle, url: String(b.url ?? "") }, ctx.fetchImpl ?? globalThis.fetch);
      send(res, 201, { url: (r.event.payload as any).url, counted: r.counted, reason: r.reason, tweetId: r.tweetId, tweetedAt: r.tweetedAt, day: r.day, eventId: r.event.id });
    }],
    ["POST", /^\/api\/workshop\/workshares\/void$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      if (!isProducer(ctx, req)) throw new WorkshopError("producer_required", "Producer token required.", 401);
      const b = await body(req);
      const ev = voidWorkshare(ctx, { url: String(b.url ?? ""), reason: String(b.reason ?? ""), by: "producer" });
      send(res, 201, { url: (ev.payload as any).url, eventId: ev.id });
    }],
    ["GET", /^\/api\/workshop\/workshares$/, (req, res) => {
      tick();
      assertServing(ctx);
      const q = new URL(req.url ?? "/", "http://x").searchParams.get("player");
      let list = deriveWorkshares(ctx.store.all());
      if (q) list = list.filter((w) => w.player === q || w.handle.toLowerCase() === q.toLowerCase());
      send(res, 200, list);
    }],
    ["GET", /^\/api\/workshop\/nodes\/([^/]+)\/players$/, (_q, res, m) => {
      tick();
      assertServing(ctx);
      const node = deriveNodes(ctx.store.all(), ctx.config, ctx.now()).find((n) => n.nodeId === m[1]);
      if (!node) throw new WorkshopError("unknown_node", `No node ${m[1]}.`, 404);
      send(res, 200, { nodeId: node.nodeId, count: node.attributedPlayers }); // count only, never handles
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
      const b = await body(req, 64_000);
      const { event, nodeId } = registerNode(ctx, {
        operator: s.xId,
        url: clip(b.url, 200),
        publicKey: b.publicKey,
        nodeId: typeof b.nodeId === "string" ? b.nodeId : undefined,
        energy: b.energy,
        payout: b.payout,
        sig: String(b.sig ?? ""),
      });
      send(res, 201, { nodeId, eventId: event.id });
    }],
    ["POST", /^\/api\/workshop\/nodes\/payout$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      const s = requireSession(ctx, req);
      const b = await body(req);
      const ev = setPayout(ctx, { nodeId: String(b.nodeId ?? ""), payout: b.payout, byOperator: s.xId, sig: String(b.sig ?? "") });
      send(res, 201, { nodeId: (ev.payload as any).nodeId, eventId: ev.id });
    }],
    ["POST", /^\/api\/workshop\/nodes\/heartbeat$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      const b = await body(req);
      const ev = addHeartbeat(ctx, {
        nodeId: String(b.nodeId ?? ""),
        at: String(b.at ?? ""),
        sig: String(b.sig ?? ""),
        eventsVerified: Number(b.eventsVerified),
        requestsServed: Number(b.requestsServed),
        head: String(b.head ?? ""),
      });
      send(res, 201, { ok: true, eventId: ev.id });
    }],
    ["GET", /^\/api\/workshop\/nodes\/([^/]+)\/receipts$/, (_q, res, m) => {
      tick();
      assertServing(ctx);
      send(res, 200, energyReceiptsOf(ctx.store, decodeURIComponent(m[1])));
    }],
    ["POST", /^\/api\/workshop\/nodes\/([^/]+)\/authorize$/, async (req, res, m) => {
      tick();
      assertCoordinator(ctx);
      const s = requireSession(ctx, req);
      const b = await body(req);
      const ev = await authorizeNode(ctx, { nodeId: decodeURIComponent(m[1]), url: String(b.url ?? ""), byOperator: s.xId, byHandle: s.handle }, ctx.fetchImpl ?? globalThis.fetch);
      send(res, 201, { nodeId: (ev.payload as any).nodeId, url: (ev.payload as any).url, eventId: ev.id });
    }],
    ["POST", /^\/api\/workshop\/audits$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      const s = requireSession(ctx, req);
      const b = await body(req);
      const r = reportPeerAudit(ctx, {
        reporterNode: String(b.reporterNode ?? ""),
        target: String(b.target ?? ""),
        k: Number(b.k),
        hash: String(b.hash ?? ""),
        head: String(b.head ?? ""),
        sig: String(b.sig ?? ""),
        byOperator: s.xId,
      });
      send(res, 201, { confirmed: r.confirmed, eventId: r.event.id });
    }],
    ["GET", /^\/api\/workshop\/audit-proof$/, (req, res) => {
      tick();
      assertServing(ctx);
      if (!ctx.nodeSign || !ctx.nodeId) throw new WorkshopError("audit_proof_unavailable", "Only a running node answers audit challenges.", 503);
      const k = Number(new URL(req.url ?? "/", "http://x").searchParams.get("k") ?? NaN);
      const target = ctx.store.all().find((e) => e.seq === k);
      if (!Number.isInteger(k) || !target) throw new WorkshopError("bad_audit", `No event with seq ${Number.isInteger(k) ? k : "?"} on this chain.`, 404);
      const head = ctx.store.all().length ? ctx.store.head : "genesis";
      const sig = ctx.nodeSign(auditMessage(ctx.nodeId, k, target.hash, head)).toString("base64");
      send(res, 200, { nodeId: ctx.nodeId, k, hash: target.hash, head, sig });
    }],
    ["GET", /^\/api\/workshop\/audits$/, (req, res) => {
      tick();
      assertServing(ctx);
      const nodeId = new URL(req.url ?? "/", "http://x").searchParams.get("node") ?? undefined;
      send(res, 200, deriveAudits(ctx.store.all(), nodeId));
    }],
    ["GET", /^\/api\/workshop\/flags$/, (_q, res) => {
      tick();
      assertServing(ctx);
      send(res, 200, deriveFlags(ctx.store.all())); // pseudonymous until appealed or resolved
    }],
    ["POST", /^\/api\/workshop\/flags$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      const s = requireSession(ctx, req);
      const b = await body(req);
      const ev = raiseFlag(ctx, { subject: String(b.subject ?? ""), subjectKind: b.subjectKind, signal: clip(b.signal, 60) || "abuse_report", evidence: b.evidence, reporter: s.xId }, `x:${s.xId}`);
      send(res, 201, { id: (ev.payload as any).id, eventId: ev.id });
    }],
    ["POST", /^\/api\/workshop\/flags\/([^/]+)\/appeal$/, async (req, res, m) => {
      tick();
      assertCoordinator(ctx);
      const s = requireSession(ctx, req);
      const b = await body(req);
      const ev = appealFlag(ctx, { id: decodeURIComponent(m[1]), reason: String(b.reason ?? ""), xId: s.xId, handle: s.handle });
      send(res, 201, { id: (ev.payload as any).id, eventId: ev.id });
    }],
    ["POST", /^\/api\/workshop\/flags\/([^/]+)\/resolve$/, async (req, res, m) => {
      tick();
      assertCoordinator(ctx);
      if (!isProducer(ctx, req)) throw new WorkshopError("producer_required", "Producer token required.", 401);
      const b = await body(req);
      const ev = resolveFlag(ctx, { id: decodeURIComponent(m[1]), decision: String(b.decision ?? ""), note: String(b.note ?? ""), by: "producer" });
      send(res, 201, { id: (ev.payload as any).id, decision: (ev.payload as any).decision, eventId: ev.id });
    }],
    ["GET", /^\/api\/workshop\/challenges$/, (_q, res) => {
      tick();
      assertServing(ctx);
      send(res, 200, deriveChallenges(ctx.store.all()));
    }],
    ["POST", /^\/api\/workshop\/challenges$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      const s = requireSession(ctx, req);
      const b = await body(req);
      const ev = fileChallenge(ctx, { claim: String(b.claim ?? ""), evidence: String(b.evidence ?? ""), by: s.xId, handle: s.handle });
      send(res, 201, { id: (ev.payload as any).id, eventId: ev.id });
    }],
    ["POST", /^\/api\/workshop\/challenges\/([^/]+)\/resolve$/, async (req, res, m) => {
      tick();
      assertCoordinator(ctx);
      if (!isProducer(ctx, req)) throw new WorkshopError("producer_required", "Producer token required.", 401);
      const b = await body(req);
      const r = resolveChallenge(ctx, { id: decodeURIComponent(m[1]), decision: String(b.decision ?? ""), note: String(b.note ?? ""), by: "producer" });
      send(res, 201, { id: (r.event.payload as any).id, decision: (r.event.payload as any).decision, reproposed: r.reproposed ? (r.reproposed.payload as any).hash : null, eventId: r.event.id });
    }],
    ["POST", /^\/api\/workshop\/settlement\/finalize$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      if (!isProducer(ctx, req)) throw new WorkshopError("producer_required", "Producer token required.", 401);
      const ev = finalizeSettlement(ctx, "producer");
      send(res, 201, { hash: (ev.payload as any).hash, eventId: ev.id });
    }],
    ["POST", /^\/api\/workshop\/generate$/, async (req, res) => {
      tick();
      assertCoordinator(ctx);
      const s = requireSession(ctx, req);
      const b = await body(req);
      const r = requestGeneration(ctx, { player: s.xId, ideaId: String(b.ideaId ?? "") });
      send(res, 201, { id: r.id, ideaId: String(b.ideaId ?? ""), spent: r.spent, remaining: r.remaining, eventId: r.event.id });
    }],
    ["GET", /^\/api\/workshop\/settlement$/, (_q, res) => {
      tick();
      assertServing(ctx);
      send(res, 200, deriveSettlementPhase(ctx.store.all(), ctx.config, ctx.now()));
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
      const url = new URL(req.url ?? "/", "http://x");
      if (ctx.mode !== "coordinator") {
        const q = url.searchParams.toString();
        res.writeHead(302, { location: `${ctx.upstream}/api/workshop/auth/x/start${q ? `?${q}` : ""}` });
        return res.end();
      }
      if (!authConfigured()) throw new WorkshopError("x_auth_not_configured", "X sign-in is not configured on this coordinator.", 503);
      const { url: authUrl } = beginAuth(url.searchParams.get("via"));
      res.writeHead(302, { location: authUrl });
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
      const claimed = takeVerifier(url.searchParams.get("state") ?? "");
      const code = url.searchParams.get("code") ?? "";
      if (!claimed || !code) throw new WorkshopError("bad_callback", "Sign-in did not complete. Start again.", 400);
      let profile;
      try {
        profile = await verifyCode(code, claimed.verifier, ctx.fetchImpl ?? globalThis.fetch);
      } catch (e: any) {
        throw new WorkshopError("x_verify_failed", `X verification failed: ${e?.message ?? e}`, 502);
      }
      // Access token already discarded inside verifyCode. One player per X id.
      // Admission first: a refused sign-in leaves no player record. First
      // sign-in binds the player to the node they came through, forever.
      const isNew = !hasPlayer(ctx.store, profile.xId);
      if (isNew) resolveAttributionTarget(ctx, profile.xId, claimed.via);
      try {
        addPlayer(ctx, profile);
      } catch (e) {
        if (!(e instanceof WorkshopError && e.code === "duplicate_player")) throw e;
      }
      if (isNew) attributePlayer(ctx, profile.xId, claimed.via);
      if (!hasPlayer(ctx.store, profile.xId)) throw new WorkshopError("not_a_player", "Player record missing after verification.", 500);
      const secure = authEnv().callbackUrl.startsWith("https://");
      res.writeHead(302, { location: "/workshop", "set-cookie": sessionCookieHeader(signSession(authEnv().secret, profile, ctx.now()), secure) });
      res.end();
    }],
    ["POST", /^\/mcp$/, mcpHttpHandler(ctx)],
  ];
}
