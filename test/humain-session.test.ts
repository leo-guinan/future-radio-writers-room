import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "humain-data-"));
import assert from "node:assert/strict";
import { EventStore } from "../src/core/events.ts";
import { Room, RuleError } from "../src/core/room.ts";
import { Deadline } from "../src/humain/clock.ts";
import { SessionController } from "../src/humain/session.ts";
import { OfflinePlanner } from "../src/humain/adapters.ts";
import { loadWorks } from "../src/humain/frame-maker.ts";

const fresh = () => new Room(new EventStore(null));
const rule = (fn: () => unknown, name: string) =>
  assert.throws(fn, (e: unknown) => e instanceof RuleError && e.rule === name);

function planned(room: Room, saveTranscript = false): SessionController {
  const s = SessionController.open(room, "leo", 2, saveTranscript);
  s.startRecording("test");
  s.ingestTranscript("Build a webpage comparing two works with one hook and a vintage visitor counter.", true, "test");
  s.closeInput("test");
  return s;
}

async function approved(room: Room): Promise<SessionController> {
  const s = planned(room);
  const planner = new OfflinePlanner();
  const { draft } = await planner.plan(s.ideaText(), { works: loadWorks() });
  s.recordPlan({ idea: s.ideaText(), hook: draft.hook, planner: planner.id, tasks: draft.tasks.map((t, i) => ({ ...t, taskId: `${s.sessionId}-T${i + 1}` })) });
  s.recordCapabilities({ reuse: [], build: [] });
  s.recordEstimate({ apiUsd: 0, localHours: 0.9, executionSeconds: 60, forecastId: "F-001" });
  s.recordContract(
    { desired: "test", observed: [], satisfied: [], modifications: [], missing: [], acceptance: [{ id: `${s.sessionId}-A1`, description: "t", check: "workspace.file", target: `${s.sessionId}-T1`, expected: "frame/index.html" }], limits: { spendCeilingUsd: null, computeDeadlineSecs: null } },
    [],
  );
  s.approve(5, 300);
  return s;
}

test("monotonic deadlines expire and report remaining time", async () => {
  const d = Deadline.in(50);
  assert.equal(d.expired(), false);
  assert.ok(d.remainingMs() > 0 && d.remainingMs() <= 50);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(d.expired(), true);
  assert.equal(d.remainingMs(), 0);
  const past = Deadline.fromWallIso(new Date(Date.now() - 1000).toISOString());
  assert.equal(past.expired(), true);
});

test("only 2/5/15/60 minute input windows are allowed", () => {
  const room = fresh();
  rule(() => SessionController.open(room, "leo", 7, false), "humain");
  const s = SessionController.open(room, "leo", 15, false);
  assert.equal(s.sessionId, "H-0001");
  assert.equal(s.state().phase, "listening");
});

test("recording starts only explicitly and never restarts after input closes", () => {
  const room = fresh();
  const s = planned(room);
  rule(() => s.startRecording("sneaky"), "humain"); // input closed: no restart
  rule(() => s.ingestTranscript("one more thing", true, "test"), "humain");
});

test("input deadline stops capture and rejects further input", () => {
  const room = fresh();
  const s = SessionController.open(room, "leo", 2, false);
  s.startRecording("test");
  assert.equal(s.isRecording, true);
  (s as any).inputDeadline = Deadline.fromWallIso(new Date(Date.now() - 1000).toISOString());
  assert.equal(s.closeInputIfExpired(), true);
  assert.equal(s.isRecording, false); // capture stopped
  assert.equal(s.state().phase, "terminal"); // nothing captured: session over
  rule(() => s.startRecording("never"), "humain"); // never silently restarts
  rule(() => s.ingestTranscript("late", true, "test"), "humain");
});

test("input deadline with captured speech closes input but keeps the session", () => {
  const room = fresh();
  const s = SessionController.open(room, "leo", 2, false);
  s.startRecording("test");
  s.ingestTranscript("a spoken idea", true, "test");
  (s as any).inputDeadline = Deadline.fromWallIso(new Date(Date.now() - 1000).toISOString());
  assert.equal(s.closeInputIfExpired(), true);
  assert.equal(s.state().phase, "input-closed");
  assert.equal(s.ideaText(), "a spoken idea");
  rule(() => s.ingestTranscript("late", true, "test"), "humain");
});

test("transcripts hit the log only with explicit permission", () => {
  const room = fresh();
  planned(room, false);
  assert.equal(room.store.all().filter((e) => e.type === "humain.transcript").length, 0);
  const room2 = fresh();
  planned(room2, true);
  assert.equal(room2.store.all().filter((e) => e.type === "humain.transcript").length, 1);
});

test("planning needs closed input and a non-empty plan", () => {
  const room = fresh();
  const s = SessionController.open(room, "leo", 2, false);
  rule(() => s.recordPlan({ idea: "x", hook: "y", planner: "p", tasks: [] }), "humain");
  s.ingestTranscript("an idea", true, "test");
  rule(() => s.recordPlan({ idea: "an idea", hook: "y", planner: "p", tasks: [{ taskId: "t", title: "t", kind: "build", capability: "c", detail: "d", estApiUsd: 0, estHours: 0, estSeconds: 0 }] }), "humain");
});

test("approval needs a plan, estimate, contract, ceiling and compute deadline", async () => {
  const room = fresh();
  const s = planned(room);
  rule(() => s.approve(5, 60), "humain"); // no plan yet
  const planner = new OfflinePlanner();
  const { draft } = await planner.plan(s.ideaText(), { works: loadWorks() });
  s.recordPlan({ idea: s.ideaText(), hook: draft.hook, planner: planner.id, tasks: draft.tasks.map((t, i) => ({ ...t, taskId: `${s.sessionId}-T${i + 1}` })) });
  s.recordCapabilities({ reuse: [], build: [] });
  s.recordEstimate({ apiUsd: 0, localHours: 1, executionSeconds: 5, forecastId: "F-001" });
  rule(() => s.approve(5, 60), "humain"); // no contract yet
  const s2 = await approved(fresh());
  assert.ok(s2.currentApproval);
  assert.equal(s2.state().phase, "approved");
  assert.deepEqual(s2.state().contract?.limits, { spendCeilingUsd: 5, computeDeadlineSecs: 300 });
});

test("no human decisions during an execution run", async () => {
  const s = await approved(fresh());
  s.beginExecution();
  rule(() => s.resolveDecision("T1", "go left", "leo"), "humain");
});

test("compute deadline rejects new actions", async () => {
  const room = fresh();
  const s = planned(room);
  const planner = new OfflinePlanner();
  const { draft } = await planner.plan(s.ideaText(), { works: loadWorks() });
  s.recordPlan({ idea: s.ideaText(), hook: draft.hook, planner: planner.id, tasks: draft.tasks.map((t, i) => ({ ...t, taskId: `${s.sessionId}-T${i + 1}` })) });
  s.recordCapabilities({ reuse: [], build: [] });
  s.recordEstimate({ apiUsd: 0, localHours: 1, executionSeconds: 5, forecastId: "F-001" });
  s.recordContract(
    { desired: "test", observed: [], satisfied: [], modifications: [], missing: [], acceptance: [{ id: `${s.sessionId}-A1`, description: "t", check: "workspace.file", target: `${s.sessionId}-T1`, expected: "frame/index.html" }], limits: { spendCeilingUsd: null, computeDeadlineSecs: null } },
    [],
  );
  s.approve(5, 1);
  s.guardAction(0); // inside the deadline
  await new Promise((r) => setTimeout(r, 1100));
  rule(() => s.guardAction(0), "humain"); // past it: rejected
  assert.equal(s.state().terminal?.reason, "compute-deadline");
});

test("spending ceiling refuses the action that would breach it", async () => {
  const s = await approved(fresh());
  s.guardAction(5); // exactly at ceiling: fine
  rule(() => s.guardAction(5.01), "humain");
  assert.equal(s.state().terminal?.reason, "budget");
});

test("success without evidence is recorded as unverified, never success", async () => {
  const s = await approved(fresh());
  const r = s.recordTaskResult({ taskId: "T1", status: "success", detail: "trust me", costUsd: 0, seconds: 1 });
  assert.equal(r.status, "unverified");
  const ok = s.recordTaskResult({ taskId: "T2", status: "success", evidence: "sha256 abc", detail: "built", costUsd: 0, seconds: 1 });
  assert.equal(ok.status, "success");
});

test("manual stop and revocation always work", async () => {
  const s = await approved(fresh());
  s.stop("manual-stop", "changed my mind");
  assert.equal(s.state().terminal?.reason, "manual-stop");
  s.stop("revoked", "again"); // idempotent, never throws
  const s2 = SessionController.open(fresh(), "leo", 2, false);
  s2.startRecording("test");
  assert.equal(s2.isRecording, true);
  s2.stop("revoked", "revoked");
  assert.equal(s2.isRecording, false);
});

test("rebuild from the log restores state but never reopens capture", async () => {
  const store = new EventStore(null);
  const room = new Room(store);
  const s = await approved(room);
  const id = s.sessionId;
  const room2 = new Room(store); // same log, fresh room (simulates restart)
  const r = SessionController.rebuild(room2, id);
  assert.equal(r.currentPlan?.tasks.length, 4);
  assert.equal(r.state().phase, "approved");
  assert.equal(r.isRecording, false);
  rule(() => r.startRecording("after restart"), "humain");
});
