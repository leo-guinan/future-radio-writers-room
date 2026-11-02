// Verified state reconciliation: execute the approved change contract until
// acceptance tests pass, spending authority is exhausted, necessary approval
// is missing, a safety boundary is reached, or no further progress is viable.
//
// After every meaningful action the loop inspects actual state, recomputes the
// remaining delta, and chooses the next action. A failed test triggers a bounded
// repair attempt — never an automatic claim of failure or success. Approval,
// sandbox isolation and hard spending enforcement stay outside the model.

import { RuleError } from "../core/room.ts";
import type { Room } from "../core/room.ts";
import type { HumainPlanTask } from "../core/types.ts";
import type { SessionController } from "./session.ts";
import { RestrictedWorkspace, WorkspaceDenied } from "./executor.ts";
import { acceptanceSummary, observeState, runAcceptance } from "./observe.ts";
import { Watchdog } from "./watchdog.ts";
import { resolveEstimate } from "./estimate.ts";
import { buildFrame, buildFrameToRegistry, loadWorks, workById, worksFor } from "./frame-maker.ts";

/** Bounded repair attempts per task after a failed acceptance test. */
export const MAX_REPAIRS = 2;

export async function executePlan(room: Room, session: SessionController, actor: string): Promise<void> {
  const plan = session.currentPlan;
  const contract = session.currentContract;
  if (!plan || !contract) throw new RuleError("humain", "Execution needs an approved change contract.");
  session.beginExecution();
  const started = Date.now();
  const ws = RestrictedWorkspace.create(session.sessionId);
  const works = loadWorks();
  const watchdog = new Watchdog(6);
  const repairsUsed = new Map<string, number>();
  const failedFinal = new Set<string>();

  const snapshot = () => acceptanceSummary(contract, session.sessionId, session.state().results);

  const halt = (reason: "blocked" | "stalled" | "safety", detail: string) => {
    const { passed, failed } = snapshot();
    const remaining = [
      ...failed.map((id) => `acceptance ${id}`),
      ...plan.tasks.filter((t) => !session.state().results.some((r) => r.taskId === t.taskId)).map((t) => `task ${t.taskId}`),
    ];
    session.checkpoint({ reason, remaining, passed, failed, state: observeState(session.sessionId).facts.join(" | ") });
    bookActuals(room, session, actor, started);
    session.stop(reason, detail);
  };

  for (;;) {
    const { passed, failed } = snapshot();
    if (contract.acceptance.length > 0 && failed.length === 0) {
      bookActuals(room, session, actor, started);
      const secs = Math.round((Date.now() - started) / 1000);
      session.finish(`Verified state reconciliation: ${passed.length}/${contract.acceptance.length} acceptance tests pass. ${plan.tasks.length} tasks, ${session.state().repairs.length} repairs, ${secs}s.`);
      return;
    }
    const failedSet = new Set(failed);
    const task = plan.tasks.find(
      (t) => !session.state().blocked.includes(t.taskId) && !failedFinal.has(t.taskId) && (t.acceptance ?? []).some((id) => failedSet.has(id)),
    );
    if (!task) {
      const ownedByBlocked = contract.acceptance.some(
        (a) => failedSet.has(a.id) && plan.tasks.some((t) => session.state().blocked.includes(t.taskId) && (t.acceptance ?? []).includes(a.id)),
      );
      halt(
        ownedByBlocked ? "blocked" : "stalled",
        ownedByBlocked
          ? "Failing acceptance tests belong to tasks blocked on missing approval. Checkpoint preserved; no human attention is requested mid-run."
          : "No action maps to the remaining failing acceptance tests. Checkpoint preserved; this is not completion.",
      );
      return;
    }
    if (task.decision && !session.state().decisions[task.taskId]) {
      session.blockTask(task.taskId, task.decision);
      continue;
    }
    try {
      session.guardAction(task.estApiUsd); // spending authority + compute deadline, before every action
    } catch (e) {
      const { passed: p, failed: f } = snapshot();
      session.checkpoint({
        reason: session.state().terminal?.reason ?? "compute-deadline",
        remaining: [...f.map((id) => `acceptance ${id}`), `task ${task.taskId}`],
        passed: p, failed: f,
        state: observeState(session.sessionId).facts.join(" | "),
      });
      bookActuals(room, session, actor, started);
      throw e; // guardAction already terminalized (budget / compute-deadline)
    }
    if (!watchdog.noteAction(passed.length)) {
      halt("stalled", `Watchdog: ${watchdog.stalledActions} actions without acceptance progress. Runaway execution halted; checkpoint preserved.`);
      return;
    }
    // Run the task, then verify its acceptance tests; failures get bounded repair.
    const owned = (task.acceptance ?? []).map((id) => contract.acceptance.find((a) => a.id === id)!).filter(Boolean);
    const verifyOwned = () => owned.every((t) => runAcceptance(t, session.sessionId, session.state().results).pass);
    const retry = async () => {
      await runTask(room, session, actor, ws, works, plan, task);
    };
    try {
      await retry();
    } catch (e: any) {
      if (e instanceof WorkspaceDenied) {
        halt("safety", `Safety boundary reached: ${e.message}. Checkpoint preserved.`);
        return;
      }
      await repairOrFail(session, task, owned.map((a) => a.id).join(",") || "task threw", e?.message ?? String(e), repairsUsed, failedFinal, retry, verifyOwned);
      continue;
    }
    for (const test of owned) {
      const outcome = runAcceptance(test, session.sessionId, session.state().results);
      if (!outcome.pass) {
        await repairOrFail(session, task, `${test.id} (${outcome.detail})`, outcome.detail, repairsUsed, failedFinal, retry, verifyOwned);
        break; // re-observe from the top after any repair cycle
      }
    }
  }
}

async function repairOrFail(
  session: SessionController,
  task: HumainPlanTask,
  trigger: string,
  detail: string,
  repairsUsed: Map<string, number>,
  failedFinal: Set<string>,
  retry: () => Promise<void>,
  verify: () => boolean,
): Promise<void> {
  const used = repairsUsed.get(task.taskId) ?? 0;
  if (used >= MAX_REPAIRS) {
    failedFinal.add(task.taskId);
    session.recordTaskResult({ taskId: task.taskId, status: "failed", detail: `${detail} (${MAX_REPAIRS} bounded repairs exhausted)`, costUsd: 0, seconds: 0 });
    return;
  }
  repairsUsed.set(task.taskId, used + 1);
  let fixed = false;
  try {
    await retry();
    fixed = verify();
  } catch {
    fixed = false;
  }
  session.recordRepair({ taskId: task.taskId, attempt: used + 1, maxAttempts: MAX_REPAIRS, trigger, action: `re-ran ${task.capability}`, outcome: fixed ? "fixed" : "still-failing" });
  if (!fixed && used + 1 >= MAX_REPAIRS) {
    failedFinal.add(task.taskId);
    session.recordTaskResult({ taskId: task.taskId, status: "failed", detail: `${detail} (${MAX_REPAIRS} bounded repairs exhausted)`, costUsd: 0, seconds: 0 });
  }
}

async function runTask(
  _room: Room,
  session: SessionController,
  _actor: string,
  ws: RestrictedWorkspace,
  works: ReturnType<typeof loadWorks>,
  plan: { hook: string; tasks: Array<{ detail: string }> },
  task: HumainPlanTask,
): Promise<void> {
  const t0 = Date.now();
  const secs = () => Math.round((Date.now() - t0) / 1000);
  if (task.capability === "frame.build") {
    if (!task.frame?.frameId) throw new Error(`${task.taskId}: contract did not assign a frame id.`);
    const a = workById(works, task.frame.workA);
    const b = workById(works, task.frame.workB);
    const { meta, checks } = buildFrameToRegistry(task.frame.frameId, session.sessionId, task.frame.hook, a, b);
    session.recordFrame({ frameId: meta.frameId, hook: meta.hook, workA: meta.workA, workB: meta.workB, path: `${meta.frameId}/index.html`, sha256: meta.sha256, visits: 0 });
    session.recordArtifact({ taskId: task.taskId, path: `frames/${meta.frameId}/index.html`, sha256: meta.sha256, bytes: meta.bytes, label: `Frame ${meta.frameId}: ${a.title} vs ${b.title}` });
    session.recordTaskResult({
      taskId: task.taskId, status: "success",
      evidence: `frame ${meta.frameId} sha256 ${meta.sha256}; ${checks.join(", ")}`,
      detail: `Published frame ${meta.frameId} (${meta.bytes} bytes). Checks: ${checks.join(", ")}.`,
      costUsd: 0, seconds: secs(),
    });
    return;
  }
  if (task.capability === "frame-maker" || task.capability === "visitor-counter") {
    // Legacy v1 tasks: single fixed example in the disposable workspace.
    const [a, b] = worksFor(plan, works);
    const frame = buildFrame(ws, a, b, plan.hook);
    session.recordArtifact({ taskId: task.taskId, path: frame.file, sha256: frame.sha256, bytes: frame.bytes, label: `Comparison page: ${a.title} vs ${b.title}` });
    session.recordTaskResult({
      taskId: task.taskId, status: "success",
      evidence: `sha256 ${frame.sha256}; ${frame.checks.join(", ")}`,
      detail: `Built ${frame.file} (${frame.bytes} bytes). Checks: ${frame.checks.join(", ")}.`,
      costUsd: 0, seconds: secs(),
    });
    return;
  }
  if (task.capability === "catalog-works") {
    const [a, b] = worksFor(plan, works);
    session.recordTaskResult({
      taskId: task.taskId, status: "success",
      evidence: `catalog works ${a.work_id}, ${b.work_id}`,
      detail: `Reused catalog entries ${a.work_id} and ${b.work_id}.`,
      costUsd: 0, seconds: secs(),
    });
    return;
  }
  if (task.capability === "evidence-checks" || task.capability === "verify") {
    const frames = session.state().frames;
    const ok = frames.length > 0;
    if (!ok) throw new Error("No published frames to verify.");
    const report = JSON.stringify({ at: new Date().toISOString(), frames: frames.map((f) => ({ frameId: f.frameId, sha256: f.sha256 })) }, null, 2);
    ws.writeFile(task.capability === "verify" ? "frame/verify.json" : "frame/index.html", report);
    session.recordTaskResult({
      taskId: task.taskId, status: "success",
      evidence: `frames: ${frames.map((f) => f.frameId).join(", ")}`,
      detail: `Verified ${frames.length} published frame(s).`,
      costUsd: 0, seconds: secs(),
    });
    return;
  }
  session.recordTaskResult({
    taskId: task.taskId, status: "unverified",
    detail: `No executor for capability '${task.capability}'. Left unverified.`,
    costUsd: 0, seconds: secs(),
  });
}

function bookActuals(room: Room, session: SessionController, actor: string, started: number): void {
  const secs = Math.round((Date.now() - started) / 1000);
  const hours = Math.round((secs / 3600) * 100) / 100;
  room.addLedgerEntry(actor, {
    ledger: "operations", kind: "expense", amount: session.state().spendUsd, unit: "usd",
    status: "observed", label: `ACTUAL ${session.sessionId} API spend`,
    evidence: session.sessionId,
  }, "producer");
  if (hours > 0)
    room.addLedgerEntry(actor, {
      ledger: "effort", kind: "hours", amount: hours, unit: "hours",
      status: "observed", label: `ACTUAL ${session.sessionId} local effort`, who: actor,
    }, "producer");
  const forecastId = session.state().estimate?.forecastId;
  if (forecastId) resolveEstimate(room, actor, forecastId, { apiUsd: session.state().spendUsd, localHours: hours, executionSeconds: secs });
}
