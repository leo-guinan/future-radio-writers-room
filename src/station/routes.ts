// Station HTTP: the frame page, the open feeds (CORS *, no auth: anyone may pull, fork, layer
// or connect them), media with range requests, and producer-only programming endpoints.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { grid, loadLineup, onAir, ROOT } from "./schedule.ts";
import { events, listen } from "./log.ts";
import { DATA, loadRules } from "./rules.ts";
import { approve, propose } from "./program.ts";
import { pollOnce } from "./watcher.ts";
import type { Archive } from "./archive.ts";
import * as live from "../live/controller.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => Promise<void> | void;
const OPEN = { "access-control-allow-origin": "*", "cache-control": "no-store" };
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...OPEN });
  res.end(JSON.stringify(body));
};
const q = (req: IncomingMessage) => new URL(req.url ?? "/", "http://x").searchParams;

async function readJson(req: IncomingMessage, max = 4_000_000) {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new Error("Request too large.");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, type: string) {
  if (!existsSync(file)) return json(res, 404, { error: "Not found" });
  const size = statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ""));
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1, ...OPEN, "cache-control": "public, max-age=3600" });
    return void createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", ...OPEN, "cache-control": "public, max-age=3600" });
  createReadStream(file).pipe(res);
}

export function stationRoutes(opts: { isProducer: (req: IncomingMessage) => boolean; producer: string; archive: () => Archive }): Array<[string, RegExp, Handler]> {
  const lineup = () => loadLineup();
  const now = () => Date.now() / 1000;
  const programView = (p: ReturnType<typeof lineup>["programs"][number]) => ({ id: p.id, title: p.title, youtube: p.youtube || null, media: `/station/media/${p.id}.mp4`, duration: p.duration });
  const guard = (req: IncomingMessage) => {
    if (!opts.isProducer(req)) throw Object.assign(new Error("Producer only."), { status: 401 });
  };
  const wrap = (h: Handler): Handler => async (req, res, m) => {
    try { await h(req, res, m); } catch (e: any) { json(res, e.status ?? 400, { error: e.message }); }
  };
  return [
    ["OPTIONS", /^\/station\/.*$/, (_req, res) => { res.writeHead(204, { ...OPEN, "access-control-allow-headers": "*" }); res.end(); }],
    ["GET", /^\/station\/?$/, (_req, res) => {
      res.writeHead(302, { location: "/station.html" + (_req.url?.includes("?") ? _req.url.slice(_req.url.indexOf("?")) : "") });
      res.end();
    }],
    ["GET", /^\/station\/feed\/schedule\.json$/, (req, res) => {
      const l = lineup();
      const hours = Math.min(48, Number(q(req).get("hours") ?? 24));
      json(res, 200, { station: l.name, anchor: l.anchor, ident_secs: l.ident_secs, programs: l.programs.map(programView), grid: grid(l, now(), hours).map((s) => ({ id: s.program.id, title: s.program.title, start: new Date(s.start * 1000).toISOString(), end: new Date(s.end * 1000).toISOString() })) });
    }],
    ["GET", /^\/station\/feed\/now\.json$/, (_req, res) => {
      const a = onAir(lineup(), now());
      json(res, 200, { at: new Date().toISOString(), program: programView(a.slot.program), offset: a.offset, ident: a.ident, start: new Date(a.slot.start * 1000).toISOString() });
    }],
    ["GET", /^\/station\/feed\/events\.json$/, (req, res) => {
      const since = Number(q(req).get("since") ?? 0);
      const types = (q(req).get("types") ?? "bulletin,program.applied,rule.added,rule.removed,skip").split(",");
      json(res, 200, { events: events().filter((e) => e.seq > since && types.includes(e.type)).slice(-200) });
    }],
    ["GET", /^\/station\/feed\/rules\.json$/, (_req, res) => json(res, 200, { owner: process.env.STATION_OWNER ?? "leo_guinan", rules: loadRules() })],
    ["GET", /^\/station\/feed\/live$/, (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive", ...OPEN });
      const since = Number(q(req).get("since") ?? events().at(-1)?.seq ?? 0);
      for (const e of events().filter((x) => x.seq > since)) res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      const off = listen((e) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(`: ${Date.now()}\n\n`), 20000);
      req.on("close", () => { off(); clearInterval(ping); });
    }],
    ["GET", /^\/station\/media\/([\w-]+)\.mp4$/, (req, res, m) => {
      const p = lineup().programs.find((x) => x.id === m[1]);
      if (!p) return json(res, 404, { error: "No such program" });
      sendFile(req, res, join(ROOT, p.file), "video/mp4");
    }],
    ["GET", /^\/station\/audio\/([\w-]+\.mp3)$/, (req, res, m) => sendFile(req, res, join(DATA(), "audio", basename(m[1])), "audio/mpeg")],
    // The live run: the library plays once; one thread's updates interrupt it.
    ["GET", /^\/live\/?$/, (req, res) => { res.writeHead(302, { location: "/live.html" + (req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "") }); res.end(); }],
    ["GET", /^\/live\/feed\/state\.json$/, (_req, res) => json(res, 200, live.publicState() ?? { phase: "idle" })],
    ["POST", /^\/api\/live\/start$/, wrap(async (req, res) => {
      guard(req);
      const b = await readJson(req);
      json(res, 201, await live.start({ thread: String(b.thread ?? process.env.LIVE_THREAD ?? ""), source: String(b.source ?? process.env.LIVE_SOURCE ?? "push"), library: b.library, fixture: b.fixture, askFixture: b.ask_fixture, pollSecs: b.poll_secs }));
    })],
    ["POST", /^\/api\/live\/update$/, wrap(async (req, res) => {
      guard(req);
      const b = await readJson(req);
      if (!["reply", "quote", "repost", "like", "bookmark", "views"].includes(b.type)) throw new Error("type must be reply, quote, repost, like, bookmark or views");
      const u = { id: String(b.id ?? `${b.type}:push:${Date.now()}`), type: b.type, at: new Date().toISOString(), user: b.user, name: b.name, text: b.text, url: b.url, count: b.count };
      json(res, live.queue(u) ? 202 : 409, { queued: u.id });
    })],
    ["GET", /^\/live\/feed\/segments\.json$/, (_req, res) => json(res, 200, { segments: live.listSegments() })],
    ["POST", /^\/api\/live\/reair$/, wrap(async (req, res) => {
      guard(req);
      const b = await readJson(req);
      const u = { id: `reair:${b.segment}:${Date.now()}`, type: "reair" as const, at: new Date().toISOString(), segment: String(b.segment) };
      json(res, live.queue(u) ? 202 : 409, { queued: u.id });
    })],
    ["POST", /^\/api\/live\/stop$/, wrap(async (req, res) => { guard(req); live.stop(); json(res, 200, { stopped: true }); })],
    // Producer: program the triggers by voice (base64 WAV) or text; approve; poll now.
    ["POST", /^\/api\/station\/program$/, wrap(async (req, res) => {
      guard(req);
      const b = await readJson(req);
      json(res, 201, await propose({ text: b.text, wav: b.audio_b64 ? Buffer.from(String(b.audio_b64), "base64") : undefined }));
    })],
    ["POST", /^\/api\/station\/program\/(P-\d{4})\/approve$/, wrap(async (req, res, m) => {
      guard(req);
      json(res, 200, approve(m[1], opts.producer));
    })],
    ["POST", /^\/api\/station\/poll$/, wrap(async (req, res) => {
      guard(req);
      json(res, 200, await pollOnce(opts.archive()));
    })],
  ];
}
