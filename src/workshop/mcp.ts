// MCP server (read-only): stdio when run directly, plus Streamable HTTP at
// POST /mcp. Every tool result carries asOf (event seq + time) and closesAt.
// Writes need X sign-in in a browser, so this server never takes credentials.

import { createInterface } from "node:readline";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertServing, WorkshopError, type WorkshopCtx } from "./log.ts";
import { deriveIdeas, deriveNodes, derivePlayers, deriveRewards, deriveScoreboard, deriveStatus, deriveVotes, deriveWorkshares } from "./derive.ts";

export function asOf(ctx: WorkshopCtx): { seq: number; time: string } {
  const last = ctx.store.all().at(-1);
  return last ? { seq: last.seq, time: last.ts } : { seq: 0, time: new Date(ctx.now()).toISOString() };
}

const envelope = (ctx: WorkshopCtx, result: unknown) => ({ asOf: asOf(ctx), closesAt: ctx.config.closesAt, result });
const limitOf = (args: any, dflt: number, max: number): number => {
  const n = Number(args?.limit ?? dflt);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : dflt;
};

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  call: (ctx: WorkshopCtx, args: any) => unknown;
}

export function workshopTools(): Record<string, ToolDef> {
  return {
    workshop_status: {
      description: "Is the workshop open? Window, countdown, pledge, counts, chain head.",
      inputSchema: { type: "object", properties: {} },
      call: (ctx) => deriveStatus(ctx),
    },
    list_ideas: {
      description: "List game/video ideas, by votes or newest.",
      inputSchema: { type: "object", properties: { sort: { type: "string", enum: ["votes", "new"] }, limit: { type: "number" } } },
      call: (ctx, args) => {
        const sort = args?.sort ?? "votes";
        if (sort !== "votes" && sort !== "new") throw new WorkshopError("bad_sort", 'sort must be "votes" or "new".', 400);
        const ideas = deriveIdeas(ctx.store.all(), ctx.config);
        ideas.sort((a, b) => (sort === "votes" ? b.votes - a.votes || a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)));
        return ideas.slice(0, limitOf(args, 20, 100));
      },
    },
    get_idea: {
      description: "One idea with its votes and build.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      call: (ctx, args) => {
        const idea = deriveIdeas(ctx.store.all(), ctx.config).find((i) => i.id === args?.id);
        if (!idea) throw new WorkshopError("unknown_idea", `No idea ${args?.id}.`, 404);
        return idea;
      },
    },
    scoreboard: {
      description: "Agnolo's scoreboard: handle, points, breakdown, new-account flags.",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      call: (ctx, args) => deriveScoreboard(ctx.store.all(), ctx.config).slice(0, limitOf(args, 50, 200)),
    },
    get_player: {
      description: "One player by handle: points, breakdown, ideas, votes.",
      inputSchema: { type: "object", properties: { handle: { type: "string" } }, required: ["handle"] },
      call: (ctx, args) => {
        const handle = String(args?.handle ?? "").toLowerCase();
        const player = [...derivePlayers(ctx.store.all(), ctx.config).values()].find((p) => p.handle.toLowerCase() === handle);
        if (!player) throw new WorkshopError("unknown_player", `No player ${args?.handle}.`, 404);
        const board = deriveScoreboard(ctx.store.all(), ctx.config).find((r) => r.xId === player.xId)!;
        const ideas = deriveIdeas(ctx.store.all(), ctx.config).filter((i) => i.author === player.xId);
        return { ...player, points: board.points, breakdown: board.breakdown, ideas, votes: deriveVotes(ctx.store.all()).byVoter.get(player.xId) ?? {} };
      },
    },
    rewards: {
      description: "Pool split with the formula and every input. Projected until the prize outcome is set.",
      inputSchema: { type: "object", properties: {} },
      call: (ctx) => deriveRewards(ctx.store.all(), ctx.config, ctx.now()),
    },
    workshares: {
      description: "Verified comment workshares, optionally for one player (x id or handle).",
      inputSchema: { type: "object", properties: { player: { type: "string" } } },
      call: (ctx, args) => {
        const q = String(args?.player ?? "");
        let list = deriveWorkshares(ctx.store.all());
        if (q) list = list.filter((w) => w.player === q || w.handle.toLowerCase() === q.toLowerCase());
        return list;
      },
    },
    node_standings: {
      description: "Nodes by operator weight: attribution, uptime qualification, sqrt weight, share.",
      inputSchema: { type: "object", properties: {} },
      call: (ctx) => {
        const rewards = deriveRewards(ctx.store.all(), ctx.config, ctx.now());
        return rewards.nodes.map((n) => ({
          nodeId: n.nodeId,
          operatorHandle: n.operatorHandle,
          attributedPlayers: n.attributedPlayers,
          uptimePct: n.uptimePct,
          qualifies: n.qualifies,
          weight: n.weight,
          shareOfO: n.shareOfO,
          amount: n.amount,
        }));
      },
    },
    recent_events: {
      description: "Raw hash-chained events after a seq.",
      inputSchema: { type: "object", properties: { since: { type: "number" }, limit: { type: "number" } } },
      call: (ctx, args) => {
        const since = Number(args?.since ?? 0);
        if (!Number.isInteger(since) || since < 0) throw new WorkshopError("bad_since", "since must be a non-negative event seq.", 400);
        return ctx.store.all().filter((e) => e.seq > since).slice(0, limitOf(args, 50, 1000));
      },
    },
    verify_chain: {
      description: "Re-verify the whole hash chain.",
      inputSchema: { type: "object", properties: {} },
      call: (ctx) => ctx.store.verify(),
    },
    list_nodes: {
      description: "Volunteer nodes and their uptime.",
      inputSchema: { type: "object", properties: {} },
      call: (ctx) => deriveNodes(ctx.store.all(), ctx.config, ctx.now()),
    },
    how_to_play: {
      description: "Sign-in URL and the rules. Writes need X sign-in in a browser.",
      inputSchema: { type: "object", properties: {} },
      call: (ctx) => ({
        signInUrl: `${ctx.config.publicUrl}/api/workshop/auth/x/start`,
        workshopUrl: `${ctx.config.publicUrl}/workshop`,
        rules: [
          "Sign in with X (one player per X account).",
          `Submit up to ${ctx.config.ideasPerPlayer} ideas (game or video), each with an incentive.`,
          `Spread ${ctx.config.voteBudget} vote points across ideas, at most ${ctx.config.voteMaxPerIdea} on one. Move them until close.`,
          `Scores: idea ${ctx.config.points.idea}, vote received ${ctx.config.points.voteReceived}, built ${ctx.config.points.built}, node uptime hour ${ctx.config.points.uptimeHour}.`,
          `The workshop closes at ${ctx.config.closesAt}; writes then return 409.`,
        ],
      }),
    },
  };
}

const TOOLS = workshopTools();

// ---------------------------------------------------------------- JSON-RPC

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

export async function handleMcpMessage(ctx: WorkshopCtx, msg: any): Promise<Record<string, unknown> | null> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return err(msg?.id ?? null, -32600, "Invalid JSON-RPC request.");
  const id = msg.id ?? null;
  if (id === null && msg.method.startsWith("notifications/")) return null; // notification: no reply
  try {
    ctx.store.sync();
    assertServing(ctx);
    switch (msg.method) {
      case "initialize":
        return ok(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "art-bus-workshop", version: "0.1.0" } });
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
        });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const tool = TOOLS[name];
        if (!tool) return err(id, -32602, `Unknown tool ${JSON.stringify(name)}.`);
        try {
          const result = tool.call(ctx, msg.params?.arguments ?? {});
          return ok(id, { content: [{ type: "text", text: JSON.stringify(envelope(ctx, result)) }] });
        } catch (e) {
          const text = e instanceof WorkshopError ? `${e.code}: ${e.message}` : (e as Error)?.message ?? String(e);
          return ok(id, { content: [{ type: "text", text }], isError: true });
        }
      }
      default:
        if (msg.method.startsWith("notifications/")) return null;
        return err(id, -32601, `Unknown method ${msg.method}.`);
    }
  } catch (e) {
    if (e instanceof WorkshopError) return err(id, -32000, `${e.code}: ${e.message}`);
    throw e;
  }
}

// ---------------------------------------------------------------- transports

export async function serveStdio(ctx: WorkshopCtx): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let reply: unknown = null;
    try {
      reply = await handleMcpMessage(ctx, JSON.parse(line));
    } catch {
      reply = err(null, -32700, "Parse error.");
    }
    if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
  }
}

export function mcpHttpHandler(ctx: WorkshopCtx) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += c.length;
      if (size > 64_000) {
        res.writeHead(413, { "content-type": "application/json" });
        return res.end(JSON.stringify(err(null, -32600, "Request too large.")));
      }
      chunks.push(c as Buffer);
    }
    let msg: any;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify(err(null, -32700, "Parse error.")));
    }
    const reply = await handleMcpMessage(ctx, msg);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply ?? { jsonrpc: "2.0", result: { ok: true } }));
  };
}

if (process.argv[1]?.endsWith("workshop/mcp.ts")) {
  const { loadWorkshopConfig } = await import("./config.ts");
  const { openWorkshop } = await import("./log.ts");
  const ctx: WorkshopCtx = { store: openWorkshop(), config: loadWorkshopConfig(), now: () => Date.now(), mode: "coordinator", producerToken: "" };
  await serveStdio(ctx);
}
