import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "humain-data-"));
import assert from "node:assert/strict";
import { EventStore } from "../src/core/events.ts";
import { Room } from "../src/core/room.ts";
import { SessionController } from "../src/humain/session.ts";
import { OfflinePlanner } from "../src/humain/adapters.ts";
import { inventory } from "../src/humain/capabilities.ts";
import { bookEstimate, estimatePlan, resolveEstimate } from "../src/humain/estimate.ts";
import { RestrictedWorkspace, WorkspaceDenied } from "../src/humain/executor.ts";
import { buildFrame, loadWorks, renderComparison } from "../src/humain/frame-maker.ts";
import { executePlan } from "../src/humain/reconcile.ts";
import { buildContract } from "../src/humain/contract.ts";

const fresh = () => new Room(new EventStore(null));
const denied = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof WorkspaceDenied);

test("comparison page carries the hook, both works and the counter", () => {
  const works = loadWorks();
  assert.ok(works.length >= 2, "catalog/works.json should hold at least two works");
  const html = renderComparison(works[0], works[1], 'A hook with <tags> & "quotes"');
  assert.ok(html.includes("A hook with &lt;tags&gt; &amp; &quot;quotes&quot;"));
  assert.ok(!html.includes("<tags>"), "hook HTML is escaped");
  assert.ok(html.includes(`data-work="${works[0].work_id}"`));
  assert.ok(html.includes(`data-work="${works[1].work_id}"`));
  assert.ok(html.includes('data-testid="visitor-counter"'));
  assert.ok(html.includes("odometer"));
});

test("frame build writes evidence-backed artifacts into the workspace", () => {
  const works = loadWorks();
  const ws = RestrictedWorkspace.create("H-0001");
  const frame = buildFrame(ws, works[0], works[1], "Two transmissions, one frequency.");
  assert.equal(frame.file, "frame/index.html");
  assert.match(frame.sha256, /^[0-9a-f]{64}$/);
  assert.ok(frame.bytes > 1000);
  assert.deepEqual(ws.list(), ["frame/index.html"]);
  ws.destroy();
  assert.throws(() => RestrictedWorkspace.open("H-0001"), (e: unknown) => e instanceof WorkspaceDenied);
});

test("workspace denies escape, secrets, and oversized writes", () => {
  const ws = RestrictedWorkspace.create("H-0002");
  denied(() => ws.writeFile("../evil.txt", "x"));
  denied(() => ws.writeFile("/abs.txt", "x"));
  denied(() => ws.writeFile(".env", "x"));
  denied(() => ws.writeFile("creds/token.json", "x"));
  denied(() => ws.writeFile("events.jsonl", "x"));
  denied(() => ws.readFile("../../package.json"));
  denied(() => ws.writeFile("big.txt", "x".repeat(600_000)));
  assert.equal(ws.exists("../evil.txt"), false);
  ws.destroy();
});

test("offline planner drafts a hook and reuse/build tasks", async () => {
  const planner = new OfflinePlanner();
  const { draft, costUsd, offline } = await planner.plan('Compare "The First Transmission" with the E10 finale', { works: loadWorks() });
  assert.equal(costUsd, 0);
  assert.equal(offline, true);
  assert.ok(draft.hook.length >= 8);
  assert.ok(draft.tasks.length >= 3);
  assert.ok(draft.tasks.some((t) => t.kind === "reuse"));
  assert.ok(draft.tasks.some((t) => t.kind === "build"));
});

test("capability inventory verifies reuse against the repo", () => {
  const inv = inventory();
  assert.ok(inv.reuse.some((r) => r.capability === "event-store"));
  assert.ok(inv.reuse.some((r) => r.capability === "cost-ledger"));
  assert.ok(inv.reuse.some((r) => r.capability === "catalog-works"));
  assert.ok(inv.build.some((b) => b.capability === "frame-maker"));
  assert.deepEqual(inv.missing, []);
});

test("estimates are labeled and booked as forecasts, never receipts", () => {
  const room = fresh();
  const s = SessionController.open(room, "leo", 2, false);
  s.ingestTranscript("an idea", true, "test");
  s.closeInput("test");
  const plan = s.recordPlan({
    idea: "an idea", hook: "a hook", planner: "test",
    tasks: [
      { taskId: "H-0001-T1", title: "a", kind: "reuse", capability: "catalog-works", detail: "d", estApiUsd: 1.5, estHours: 0.5, estSeconds: 20 },
      { taskId: "H-0001-T2", title: "b", kind: "build", capability: "frame-maker", detail: "d", estApiUsd: 0, estHours: 0.25, estSeconds: 40 },
    ],
  });
  const est = estimatePlan(plan);
  assert.deepEqual(est, { apiUsd: 1.5, localHours: 0.75, executionSeconds: 60 });
  const forecastId = bookEstimate(room, "leo", s.sessionId, est);
  const recorded = s.recordEstimate({ ...est, forecastId });
  assert.equal(recorded.label, "ESTIMATE");
  assert.ok((room.forecasts.get(forecastId)?.claim ?? "").startsWith("ESTIMATE"));
  const projected = room.ledger.filter((l) => l.status === "projected");
  assert.equal(projected.length, 2);
  assert.equal(room.ledger.filter((l) => l.status === "observed").length, 0);
  resolveEstimate(room, "leo", forecastId, est);
  assert.equal(room.forecasts.get(forecastId)?.resolution?.outcome, "supported");
});

test("approved plan executes in the workspace with evidence and actuals", async () => {
  const room = fresh();
  const s = SessionController.open(room, "leo", 2, false);
  s.ingestTranscript("Build a webpage comparing two works with one hook and a vintage visitor counter.", true, "test");
  s.closeInput("test");
  const planner = new OfflinePlanner();
  const { draft } = await planner.plan(s.ideaText(), { works: loadWorks() });
  const plan = s.recordPlan({ idea: s.ideaText(), hook: draft.hook, planner: planner.id, tasks: draft.tasks.map((t, i) => ({ ...t, taskId: `${s.sessionId}-T${i + 1}` })) });
  s.recordCapabilities({ reuse: [], build: [] });
  const est = estimatePlan(plan);
  const recorded = s.recordEstimate({ ...est, forecastId: bookEstimate(room, "leo", s.sessionId, est) });
  const { contract, frameTasks } = buildContract(s.sessionId, plan, { sessionId: s.sessionId, reuse: [], build: [] }, recorded);
  assert.ok(contract.acceptance.length >= 10, "two frames × five acceptance tests");
  s.recordContract(contract, frameTasks);
  s.approve(5, 300);
  await executePlan(room, s, "leo");
  const st = s.state();
  assert.equal(st.terminal?.reason, "done");
  for (const r of st.results) assert.equal(r.status, "success");
  for (const r of st.results) assert.ok(r.evidence, `${r.taskId} has evidence`);
  assert.equal(st.frames.length, 2, "two persistent frames published");
  assert.notEqual(st.frames[0].hook, st.frames[1].hook, "independent hooks");
  const actuals = room.ledger.filter((l) => l.status === "observed" && l.label.startsWith("ACTUAL"));
  assert.ok(actuals.length >= 1, "actuals booked as observed entries");
  assert.ok(room.forecasts.get(recorded.forecastId)?.resolution, "estimate forecast resolved against actuals");
});

test("pending decisions become blocked tasks, never silent work", async () => {
  const room = fresh();
  const s = SessionController.open(room, "leo", 2, false);
  s.ingestTranscript("an idea", true, "test");
  s.closeInput("test");
  s.recordPlan({
    idea: "an idea", hook: "h", planner: "test",
    tasks: [{ taskId: `${s.sessionId}-T1`, title: "needs a human", kind: "build", capability: "frame-maker", detail: "d", decision: "Which style?", estApiUsd: 0, estHours: 0.1, estSeconds: 5 }],
  });
  s.recordCapabilities({ reuse: [], build: [] });
  s.recordEstimate({ apiUsd: 0, localHours: 0.1, executionSeconds: 5, forecastId: "F-001" });
  s.recordContract(
    { desired: "an idea", observed: [], satisfied: [], modifications: [`${s.sessionId}-T1 needs a human`], missing: [], acceptance: [{ id: `${s.sessionId}-A1`, description: "t", check: "catalog.reused", target: `${s.sessionId}-T1`, expected: "success+evidence" }], limits: { spendCeilingUsd: null, computeDeadlineSecs: null } },
    [],
  );
  s.approve(5, 300);
  await executePlan(room, s, "leo");
  const st = s.state();
  assert.deepEqual(st.blocked, [`${s.sessionId}-T1`]);
  assert.equal(st.results[0].status, "blocked");
  assert.ok(room.store.all().some((e) => e.type === "humain.task_blocked"));
  assert.equal(st.terminal?.reason, "blocked", "run halts for missing approval, not success");
  assert.ok(st.lastCheckpoint, "checkpoint preserved");
  assert.ok(st.lastCheckpoint!.remaining.some((r) => r.includes("A1")), "remaining requirements preserved");
});
