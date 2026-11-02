// HumAIn OS HTTP routes, in the server's route-table shape.
// The browser UI drives these; the CLI demo uses the same controllers directly.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Room } from "../core/room.ts";
import { RuleError } from "../core/room.ts";
import { SessionController } from "./session.ts";
import { getSession, listSessions, register } from "./store.ts";
import { makePlanner, makeTranscriber } from "./adapters.ts";
import { inventory } from "./capabilities.ts";
import { bookEstimate, estimatePlan } from "./estimate.ts";
import { executePlan, loadWorks } from "./frame-maker.ts";
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
      const s = register(SessionController.open(room, actor, Number(b.inputWindowMin), b.saveTranscript === true));
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
      const { draft, costUsd } = await planner.plan(idea, { works });
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
      s.recordEstimate({ ...est, forecastId });
      if (typeof costUsd === "number" && costUsd > 0)
        room.addLedgerEntry(actor, {
          ledger: "operations", kind: "expense", amount: costUsd, unit: "usd",
          status: "observed", label: `${planner.id} plan ${m[1]}`, evidence: m[1],
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
      const ws = RestrictedWorkspace.open(m[1]);
      const html = ws.readFile(art.path);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    }],
    ["GET", /^\/api\/humain\/works$/, (_q, res) => {
      send(res, 200, loadWorks());
    }],
  ];
}
