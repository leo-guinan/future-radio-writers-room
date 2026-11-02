// HumAIn OS HTTP routes, in the server's route-table shape.
// The browser UI drives these; the CLI demo uses the same controllers directly.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { Room } from "../core/room.ts";
import { RuleError } from "../core/room.ts";
import { SessionController } from "./session.ts";
import { getSession, listSessions, register } from "./store.ts";
import { MetaVoiceTranscriber, makePlanner, makeTranscriber } from "./adapters.ts";
import { inventory } from "./capabilities.ts";
import { bookEstimate, estimatePlan } from "./estimate.ts";
import { buildContract } from "./contract.ts";
import { executePlan } from "./reconcile.ts";
import { loadWorks } from "./frame-maker.ts";
import { listFrames, readFrame, serveFrame } from "./frames.ts";
import { RestrictedWorkspace } from "./executor.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => Promise<void> | void;

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage, max = 64_000): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new RuleError("request", "Request too large.");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RuleError("request", "Body must be JSON.");
  }
}

export function humainRoutes(room: Room, actor: string): Array<[string, RegExp, Handler]> {
  return [
    ["POST", /^\/api\/humain\/sessions$/, async (req, res) => {
      const b = await body(req);
      const s = register(SessionController.open(room, actor, Number(b.inputWindowMin), b.saveTranscript === true, b.reserveMin === undefined ? 10 : Number(b.reserveMin)));
      send(res, 201, s.state());
    }],
    ["GET", /^\/api\/humain\/sessions$/, (_q, res) => {
      send(res, 200, { sessions: listSessions(room) });
    }],
    ["GET", /^\/api\/humain\/sessions\/(H-\d{4})$/, (_q, res, m) => {
      send(res, 200, getSession(room, m[1]).state());
    }],
    ["POST", /^\/api\/humain\/sessions\/(H-\d{4})\/recording\/start$/, async (req, res, m) => {
      const s = getSession(room, m[1]);
      const b = await body(req);
      s.startRecording(typeof b.reason === "string" && b.reason ? b.reason : "user pressed record");
      send(res, 200, s.state());
    }],
    ["POST", /^\/api\/humain\/sessions\/(H-\d{4})\/recording\/stop$/, async (req, res, m) => {
      const s = getSession(room, m[1]);
      s.stopRecording((await body(req)).reason || "user stopped recording");
      send(res, 200, s.state());
    }],
    ["POST", /^\/api\/humain\/sessions\/(H-\d{4})\/transcript$/, async (req, res, m) => {
      const s = getSession(room, m[1]);
      const b = await body(req);
      const chunk = s.ingestTranscript(String(b.text ?? ""), b.final === true, String(b.source ?? makeTranscriber().id));
      send(res, 201, { chunk, state: s.state() });
    }],
    ["POST", /^\/api\/humain\/sessions\/(H-\d{4})\/input\/close$/, async (req, res, m) => {
      const s = getSession(room, m[1]);
      s.closeInput((await body(req)).reason || "user finished speaking");
      send(res, 200, s.state());
    }],
    ["POST", /^\/api\/humain\/sessions\/(H-\d{4})\/plan$/, async (_req, res, m) => {
      const s = getSession(room, m[1]);
      const idea = s.ideaText();
      if (!idea) throw new RuleError("humain", "Nothing was said. Speak first, then plan.");
      const works = loadWorks();
      const planner = makePlanner();
      const { draft, costUsd, usage } = await planner.plan(idea, { works });
      const plan = s.recordPlan({
        idea,
        hook: draft.hook,
        planner: planner.id,
        tasks: draft.tasks.map((t, i) => ({ ...t, taskId: `${m[1]}-T${i + 1}` })),
      });
      const inv = inventory();
      s.recordCapabilities({ reuse: inv.reuse, build: inv.build });
      const est = estimatePlan(plan);
      const forecastId = bookEstimate(room, actor, m[1], est);
      const recorded = s.recordEstimate({ ...est, forecastId });
      const { contract, frameTasks } = buildContract(m[1], plan, { sessionId: m[1], reuse: inv.reuse, build: inv.build }, recorded);
      s.recordContract(contract, frameTasks);
      if (typeof costUsd === "number" && costUsd > 0)
        room.addLedgerEntry(actor, {
          ledger: "operations", kind: "expense", amount: costUsd, unit: "usd",
          status: "observed", label: `${planner.id} plan ${m[1]}`, evidence: m[1],
        }, "producer");
      else if (!planner.id.startsWith("offline/") && usage.input + usage.output > 0)
        room.addLedgerEntry(actor, {
          ledger: "operations", kind: "expense", amount: usage.input + usage.output, unit: "tokens",
          status: "unknown", label: `${planner.id} plan ${m[1]} (unpriced)`, evidence: m[1],
        }, "producer");
      send(res, 201, s.state());
    }],
    ["POST", /^\/api\/humain\/sessions\/(H-\d{4})\/approve$/, async (req, res, m) => {
      const s = getSession(room, m[1]);
      const b = await body(req);
      s.approve(Number(b.spendCeilingUsd), Number(b.computeDeadlineSecs));
      send(res, 200, s.state());
    }],
    ["POST", /^\/api\/humain\/sessions\/(H-\d{4})\/decide$/, async (req, res, m) => {
      const s = getSession(room, m[1]);
      const b = await body(req);
      s.resolveDecision(String(b.taskId), String(b.resolution ?? ""), actor);
      send(res, 200, s.state());
    }],
    ["POST", /^\/api\/humain\/sessions\/(H-\d{4})\/execute$/, async (_req, res, m) => {
      const s = getSession(room, m[1]);
      await executePlan(room, s, actor);
      send(res, 200, s.state());
    }],
    ["POST", /^\/api\/humain\/sessions\/(H-\d{4})\/stop$/, async (req, res, m) => {
      const s = getSession(room, m[1]);
      const b = await body(req);
      s.stop(b.revoke === true ? "revoked" : "manual-stop", String(b.reason || "user stopped the session"));
      send(res, 200, s.state());
    }],
    ["GET", /^\/api\/humain\/sessions\/(H-\d{4})\/events$/, (_q, res, m) => {
      send(res, 200, getSession(room, m[1]).replay());
    }],
    ["GET", /^\/api\/humain\/sessions\/(H-\d{4})\/artifact$/, (_q, res, m) => {
      const s = getSession(room, m[1]);
      const art = s.state().artifacts.at(-1);
      if (!art) throw new RuleError("humain", "No artifact yet.");
      const reg = art.path.match(/^frames\/(F-\d{4})\/index\.html$/);
      const html = reg ? readFrame(reg[1]).html : RestrictedWorkspace.open(m[1]).readFile(art.path);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    }],
    ["GET", /^\/api\/humain\/works$/, (_q, res) => {
      send(res, 200, loadWorks());
    }],
    ["POST", /^\/api\/humain\/sessions\/(H-\d{4})\/audio$/, async (req, res, m) => {
      // Server-side transcription via muse-voice-transcribe-1.0. The key never
      // leaves the server; audio is transcribed and dropped, never stored.
      if (!MetaVoiceTranscriber.available())
        throw new RuleError("humain", "Server transcription is not configured (MODEL_API_KEY). Use on-device speech or typed input.");
      const s = getSession(room, m[1]);
      const b = await body(req, 4_194_304);
      const raw = String(b.audioBase64 ?? "");
      if (!raw) throw new RuleError("request", "audioBase64 is required (mono 16-bit PCM WAV).");
      const t = new MetaVoiceTranscriber();
      const { chunks, costUsd } = await t.transcribe(Buffer.from(raw, "base64"), String(b.mime ?? "audio/wav"));
      for (const c of chunks) s.ingestTranscript(c.text, c.final, t.id);
      if (typeof costUsd === "number" && costUsd > 0)
        room.addLedgerEntry(actor, {
          ledger: "operations", kind: "expense", amount: costUsd, unit: "usd",
          status: "observed", label: `muse-voice-transcribe-1.0 ${m[1]}`, evidence: m[1],
        }, "producer");
      send(res, 201, { chunks: chunks.length, state: s.state() });
    }],
    ["GET", /^\/api\/humain\/frames$/, (_q, res) => {
      send(res, 200, listFrames());
    }],
    ["GET", /^\/api\/humain\/frames\/totals$/, (_q, res) => {
      // Totals reuse the registry's classified counts; no recounting here.
      const frames = listFrames();
      const totals = { frames: frames.length, human: 0, unique: 0, verification: 0 };
      for (const f of frames) {
        totals.human += f.counts.human;
        totals.unique += f.counts.unique;
        totals.verification += f.counts.verification;
      }
      send(res, 200, totals);
    }],
    ["GET", /^\/api\/humain\/frames\/(F-\d{4})$/, (req, res, m) => {
      // Visitor identity is a hash, never a raw address. ?as=verify records an
      // automated verification view instead of a human one.
      const url = new URL(req.url ?? "/", "http://x");
      const verify = url.searchParams.get("as") === "verify";
      const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || (req.socket.remoteAddress ?? "unknown");
      const visitor = createHash("sha256").update(ip).digest("hex").slice(0, 16);
      const { html } = serveFrame(m[1], verify ? { verify: true } : { visitor });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    }],
  ];
}
