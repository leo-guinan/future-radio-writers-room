// The workshop: patrons watch the room work, propose ideas, vote, and put questions
// to the characters. The producer drives production with a bearer token (or the CLI).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { openRoom } from "./core/open.ts";
import { RuleError } from "./core/room.ts";
import type { Character, EpisodeStage, IdeaStatus, OutputKind, RoomEvent, SignalKind } from "./core/types.ts";
import { makeLLM } from "./agents/llm.ts";
import { ask, explore } from "./agents/characters.ts";
import { checklist, nextStep } from "./production/loop.ts";
import { tick } from "./showrunner/showrunner.ts";
import { EpisodeRepo } from "./repos/episode-repo.ts";

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.PRODUCER_TOKEN ?? "";
const PRODUCER = process.env.PRODUCER_NAME ?? "leo";
const PATRON_DAILY_RUNS = Number(process.env.PATRON_DAILY_RUNS ?? 40); // whole room, per UTC day
const PATRON_RUNS_PER_IP = Number(process.env.PATRON_RUNS_PER_IP ?? 5);
const IDEAS_PER_IP = Number(process.env.IDEAS_PER_IP ?? 5);
const PUBLIC_DIR = join(process.cwd(), "public");

const INTAKE = process.env.INTAKE_EPISODE ?? "E02";
const SHOWRUNNER_AUTO = process.env.SHOWRUNNER_AUTO !== "0";
const SHOWRUNNER_EVERY = Number(process.env.SHOWRUNNER_EVERY_SECONDS ?? 300);

const room = openRoom();
const llm = makeLLM();
const votes = new Set<string>(); // ip|idea, lifetime of the process
const ipCounts = new Map<string, number>(); // day|kind|ip

// ---------------------------------------------------------------- showrunner

// Ticks run one at a time; requests for the same episode while one is queued coalesce.
let chain = Promise.resolve();
const pending = new Set<string>();
function scheduleTick(episodeId: string) {
  if (!SHOWRUNNER_AUTO || pending.has(episodeId)) return;
  const ep = room.episodes.get(episodeId);
  if (!ep || ep.releases.length) return;
  pending.add(episodeId);
  chain = chain
    .then(() => new Promise((r) => setTimeout(r, 2000)))
    .then(() => {
      pending.delete(episodeId);
      room.store.sync();
      return tick(room, llm, episodeId, { includeUnassigned: episodeId === INTAKE });
    })
    .then((t) => {
      // More work waiting (queued, or not yet explored)? Make another round.
      const unexplored = t.held.some((h) => h.failed.some((f) => f.gate === "explored"));
      const progressed = t.cut.length > 0 || t.explored.length > 0;
      if (progressed && (t.queued.length || unexplored)) setTimeout(() => scheduleTick(episodeId), 1000);
    })
    .catch((e) => console.error(`showrunner ${episodeId}:`, e.message));
}
function activeEpisodes() {
  const withIdeas = new Set([...room.ideas.values()].map((i) => i.episodeId).filter(Boolean) as string[]);
  return [...room.episodes.values()].filter((e) => !e.releases.length && (withIdeas.has(e.episodeId) || e.episodeId === INTAKE)).map((e) => e.episodeId);
}

// ---------------------------------------------------------------- helpers

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 16_000) throw new RuleError("request", "Request too large.");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RuleError("request", "Body must be JSON.");
  }
}

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const ipOf = (req: IncomingMessage) => (String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "unknown");
const today = () => new Date().toISOString().slice(0, 10);

function bump(kind: string, ip: string, limit: number) {
  const key = `${today()}|${kind}|${ip}`;
  const n = (ipCounts.get(key) ?? 0) + 1;
  if (n > limit) throw new RuleError("limits", `Daily limit reached for ${kind}. The workshop reopens tomorrow.`);
  ipCounts.set(key, n);
}

function isProducer(req: IncomingMessage) {
  if (!TOKEN) return false;
  const got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function patronRunsToday() {
  return [...room.runs.values()].filter((r) => r.askedBy.startsWith("patron:") && r.at.startsWith(today())).length;
}

function publicRun(id: string) {
  const r = room.runs.get(id);
  if (!r) return null;
  const ev = room.store.all().find((e) => e.id === r.eventId);
  if (ev?.visibility !== "public") return null;
  return { runId: r.runId, eventId: r.eventId, at: r.at, character: r.character, askedBy: r.askedBy, prompt: r.prompt, text: r.text, output: r.output, citations: r.citations, flags: r.flags, offline: r.offline };
}

function publicScorecard() {
  const s = room.scorecard();
  const publicForecastIds = new Set(
    room.store.all().filter((e) => e.type === "forecast.recorded" && e.visibility === "public").map((e) => (e.payload as any).forecastId),
  );
  return { ...s, forecasts: s.forecasts.filter((f) => publicForecastIds.has(f.id)), effort: { hoursBy: s.effort.hoursBy } };
}

function snapshot() {
  return {
    show: "Future Radio",
    offline: llm.offline,
    limits: { patronRunsToday: patronRunsToday(), patronDailyRuns: PATRON_DAILY_RUNS },
    episodes: [...room.episodes.values()].map((e) => ({
      episodeId: e.episodeId,
      number: e.number,
      title: e.title,
      logline: e.logline,
      stage: e.stage,
      deadline: e.deadline,
      round: e.round,
      ceiling: e.ceiling,
      releases: e.releases.map((r) => ({ version: r.version, uri: r.uri, sha256: r.sha256, at: r.at, invitation: r.invitation })),
    })),
    board: room.board(),
    scorecard: publicScorecard(),
    head: room.store.head,
    seq: room.store.all().length,
  };
}

// ---------------------------------------------------------------- routes

type Handler = (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => Promise<void> | void;
const routes: Array<[string, RegExp, Handler]> = [
  ["GET", /^\/api\/room$/, (_q, res) => send(res, 200, snapshot())],
  ["GET", /^\/api\/events$/, (req, res) => {
    const since = Number(new URL(req.url!, "http://x").searchParams.get("since") ?? 0);
    send(res, 200, room.publicEvents(since).slice(-300));
  }],
  ["GET", /^\/api\/stream$/, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": open\n\n");
    const redacted = (e: RoomEvent) => room.publicEvents(e.seq - 1).find((x) => x.seq === e.seq);
    const off = room.store.subscribe((e) => {
      if (e.visibility !== "public") return;
      queueMicrotask(() => res.write(`data: ${JSON.stringify(redacted(e))}\n\n`));
    });
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => (off(), clearInterval(ping)));
  }],
  ["GET", /^\/api\/episodes\/([\w-]+)$/, (_q, res, m) => {
    const e = room.mustEpisode(m[1]);
    send(res, 200, {
      episodeId: e.episodeId, number: e.number, title: e.title, logline: e.logline, stage: e.stage, ceiling: e.ceiling,
      budget: e.budget, deadline: e.deadline, stageHistory: e.stageHistory,
      scenes: [...e.scenes.values()], releases: e.releases, authorizations: e.authorizations,
      assets: e.assets.filter((a) => room.store.all().some((ev) => ev.type === "episode.asset_added" && ev.visibility === "public" && (ev.payload as any).uri === a.uri)),
      cash: room.episodeCash(e.episodeId), hours: room.episodeHours(e.episodeId),
      checklist: checklist(room, e.episodeId), next: nextStep(room, e.episodeId),
      repo: (() => {
        const r = new EpisodeRepo(e.episodeId).repo;
        return r.exists ? { name: r.name, head: r.head(), remote: r.remote() || null, log: r.log(8) } : null;
      })(),
      cuts: room.cuts.filter((c) => c.episodeId === e.episodeId).map((c) => ({ ...c, title: room.ideas.get(c.ideaId)?.title, status: room.ideas.get(c.ideaId)?.status })),
      lastTick: room.ticks.filter((t) => t.episodeId === e.episodeId).at(-1) ?? null,
    });
  }],
  ["GET", /^\/api\/episodes\/([\w-]+)\/cuts\/([\w-]+)$/, (_q, res, m) => {
    const cut = room.cuts.filter((c) => c.episodeId === m[1] && c.ideaId === m[2]).at(-1);
    if (!cut) throw new RuleError("episode", `No cut of ${m[2]} in ${m[1]}.`);
    const r = new EpisodeRepo(m[1]).repo;
    const file = (f: string) => { try { return r.showAt(cut.sha, `${cut.path}/${f}`); } catch { return ""; } };
    send(res, 200, { ...cut, card: file("CARD.md"), beats: file("BEATS.md"), script: file("SCRIPT.md") });
  }],
  ["GET", /^\/api\/ideas\/([\w-]+)$/, (_q, res, m) => {
    const i = room.mustIdea(m[1]);
    const { contact: _c, ...contributor } = i.contributor;
    send(res, 200, {
      ...i,
      contributor: contributor.credit ? contributor : { ...contributor, name: "anonymous patron" },
      runs: i.runs.map(publicRun).filter(Boolean),
      cuts: room.cuts.filter((c) => c.ideaId === i.ideaId),
    });
  }],

  // ----- patrons
  ["POST", /^\/api\/ideas$/, async (req, res) => {
    const b = await body(req);
    if (b.consent !== true) throw new RuleError("consent", "Please confirm the idea is yours to share and that the show may use it as you chose.");
    bump("ideas", ipOf(req), IDEAS_PER_IP);
    const name = clip(b.name, 60) || "a patron";
    const ev = room.proposeIdea(`patron:${name}`, {
      title: clip(b.title, 120),
      question: clip(b.question, 400),
      source: clip(b.source, 400),
      output: (["scene", "song", "episode", "trailer", "capability", "broadcast", "other"].includes(b.output) ? b.output : "scene") as OutputKind,
      episodeId: b.episodeId && room.episodes.has(b.episodeId) ? b.episodeId : undefined,
      contributor: { name, credit: b.credit !== false, reuse: ["cc-by", "show-only", "ask-first"].includes(b.reuse) ? b.reuse : "show-only", contact: clip(b.contact, 120) || undefined },
    });
    scheduleTick((ev.payload as any).episodeId ?? INTAKE);
    send(res, 201, { ideaId: (ev.payload as any).ideaId, eventId: ev.id });
  }],
  ["POST", /^\/api\/ideas\/([\w-]+)\/vote$/, (req, res, m) => {
    room.mustIdea(m[1]);
    const key = `${ipOf(req)}|${m[1]}`;
    if (votes.has(key)) throw new RuleError("limits", "You've already voted for this idea.");
    votes.add(key);
    const ev = room.signal("patron", { ideaId: m[1], kind: "community", value: 1 });
    send(res, 201, { eventId: ev.id, community: room.mustIdea(m[1]).signals.community });
  }],
  ["POST", /^\/api\/ideas\/([\w-]+)\/ask$/, async (req, res, m) => {
    const b = await body(req);
    const character = b.character as Character;
    if (!["borges", "leonardo", "agnolo"].includes(character)) throw new RuleError("request", "Ask borges, leonardo, or agnolo.");
    const question = clip(b.question, 500);
    if (!question) throw new RuleError("request", "Ask a question.");
    room.mustIdea(m[1]);
    if (patronRunsToday() >= PATRON_DAILY_RUNS) throw new RuleError("limits", "The characters have done all the patron work today's budget allows. Agnolo insists.");
    bump("asks", ipOf(req), PATRON_RUNS_PER_IP);
    const name = clip(b.name, 60) || "a patron";
    const r = await ask({ room, llm, askedBy: `patron:${name}`, scope: "public" }, character, question, m[1]);
    send(res, 201, publicRun((r.run.payload as any).runId));
  }],

  // ----- producer
  ["POST", /^\/api\/producer\/ideas\/([\w-]+)\/explore$/, async (req, res, m) => {
    requireProducer(req);
    const r = await explore({ room, llm, askedBy: PRODUCER, scope: "producer" }, m[1]);
    send(res, 201, { borges: r.memory.text, leonardo: r.created.approaches, agnolo: r.judged.evaluation, budget: r.judged.budget });
  }],
  ["POST", /^\/api\/producer\/ideas\/([\w-]+)\/move$/, async (req, res, m) => {
    requireProducer(req);
    const b = await body(req);
    send(res, 201, room.transitionIdea(PRODUCER, { ideaId: m[1], to: b.to as IdeaStatus, reason: b.reason, result: b.result, capability: b.capability, mergedInto: b.mergedInto, actual: b.actual }));
  }],
  ["POST", /^\/api\/producer\/ideas\/([\w-]+)\/signal$/, async (req, res, m) => {
    requireProducer(req);
    const b = await body(req);
    send(res, 201, room.signal(PRODUCER, { ideaId: m[1], kind: b.kind as SignalKind, value: Number(b.value), receipt: b.receipt, note: b.note }));
  }],
  ["POST", /^\/api\/producer\/episodes\/([\w-]+)\/advance$/, async (req, res, m) => {
    requireProducer(req);
    const b = await body(req);
    send(res, 201, room.advanceEpisode(PRODUCER, m[1], b.stage as EpisodeStage, b.note));
  }],
  ["POST", /^\/api\/producer\/episodes\/([\w-]+)\/tick$/, async (req, res, m) => {
    requireProducer(req);
    send(res, 201, await tick(room, llm, m[1], { includeUnassigned: m[1] === INTAKE }));
  }],
  ["GET", /^\/api\/producer\/scorecard$/, (req, res) => {
    requireProducer(req);
    send(res, 200, room.scorecard());
  }],
  ["GET", /^\/healthz$/, (_q, res) => send(res, 200, { ok: true, chain: room.store.verify() })],
];

function requireProducer(req: IncomingMessage) {
  if (!isProducer(req)) throw new RuleError("auth", "Producer token required.");
}

// ---------------------------------------------------------------- static

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };

function serveStatic(path: string, res: ServerResponse) {
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) return send(res, 404, { error: "Not found" });
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

// ---------------------------------------------------------------- server

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    room.store.sync(); // the CLI may have written since the last request
    for (const [method, re, h] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) return await h(req, res, m);
    }
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);
    send(res, 404, { error: "Not found" });
  } catch (e) {
    if (e instanceof RuleError) {
      const status = e.rule === "auth" ? 401 : e.rule === "limits" ? 429 : 400;
      return send(res, status, { error: e.message, rule: e.rule });
    }
    console.error(e);
    send(res, 500, { error: "The radio crackled. Try again." });
  }
});

// Stream CLI-written events to watchers without waiting for a request.
setInterval(() => room.store.sync(), 1500).unref();
// The showrunner also makes rounds on its own.
if (SHOWRUNNER_AUTO && SHOWRUNNER_EVERY > 0) setInterval(() => activeEpisodes().forEach(scheduleTick), SHOWRUNNER_EVERY * 1000).unref();

server.listen(PORT, () => {
  console.log(`Future Radio writers' room on http://localhost:${PORT}  (${llm.offline ? "offline characters" : `model ${llm.model}`}; ${room.store.all().length} events)`);
  if (!TOKEN) console.log("PRODUCER_TOKEN is not set: producer API is disabled. Use the CLI.");
});
