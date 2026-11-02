// The change contract: desired state, observed state, requirements already
// satisfied, reusable capabilities, required modifications, missing capabilities,
// acceptance tests, estimated costs, and authorization limits. Built from the
// plan plus an inspection of actual state — the machine's resource budget in
// one reviewable artifact.

import type { HumainAcceptanceTest, HumainCapabilities, HumainContract, HumainEstimate, HumainPlan } from "../core/types.ts";
import { allocateFrameIds } from "./frames.ts";
import { observeState, runAcceptance } from "./observe.ts";

export function buildContract(
  sessionId: string,
  plan: HumainPlan,
  capabilities: HumainCapabilities,
  estimate: HumainEstimate,
): { contract: Omit<HumainContract, "sessionId">; frameTasks: Array<{ taskId: string; frameId: string }> } {
  const observed = observeState(sessionId);
  const acceptance: HumainAcceptanceTest[] = [];
  const frameTasks: Array<{ taskId: string; frameId: string }> = [];
  let n = 0;
  const aid = () => `${sessionId}-A${++n}`;

  // Frame ids are assigned at contract time so acceptance tests name real targets.
  // Allocation is atomic: concurrent sessions can never receive the same id.
  const frameOwners = plan.tasks.filter((t) => t.frame);
  const allocated = allocateFrameIds(frameOwners.length);
  frameOwners.forEach((t, i) => frameTasks.push({ taskId: t.taskId, frameId: allocated[i] }));
  for (const t of plan.tasks) {
    if (!t.frame) continue;
    const frameId = frameTasks.find((f) => f.taskId === t.taskId)!.frameId;
    const { hook, workA, workB } = t.frame;
    acceptance.push(
      { id: aid(), description: `Frame ${frameId} exists in the registry`, check: "frame.exists", target: frameId, expected: frameId },
      { id: aid(), description: `Frame ${frameId} carries its hook`, check: "frame.hook", target: frameId, expected: hook },
      { id: aid(), description: `Frame ${frameId} has a visitor counter`, check: "frame.counter", target: frameId, expected: "data-testid=\"visitor-counter\"" },
      { id: aid(), description: `Frame ${frameId} compares both works`, check: "frame.works", target: frameId, expected: `${workA},${workB}` },
      { id: aid(), description: `Frame ${frameId} serves over HTTP`, check: "frame.serves", target: frameId, expected: "200" },
    );
  }
  for (const t of plan.tasks) {
    if (t.capability === "catalog-works")
      acceptance.push({ id: aid(), description: `Catalog reuse for ${t.taskId} is evidenced`, check: "catalog.reused", target: t.taskId, expected: "success+evidence" });
    if (t.capability === "verify")
      acceptance.push({ id: aid(), description: `Workspace verification report exists`, check: "workspace.file", target: t.taskId, expected: "frame/verify.json" });
    if (t.capability === "evidence-checks")
      acceptance.push({ id: aid(), description: `Workspace verification artifact exists`, check: "workspace.file", target: t.taskId, expected: "frame/index.html" });
  }

  // Requirements already satisfied: acceptance tests passing before execution.
  const satisfied: string[] = [];
  for (const a of acceptance) {
    if (a.check === "frame.serves") continue; // serving has a side effect (visit); don't probe pre-run
    const o = runAcceptance(a, sessionId, []);
    if (o.pass) satisfied.push(`${a.id}: ${a.description} (${o.detail})`);
  }

  const modifications = plan.tasks.map((t) => `${t.taskId} [${t.kind}/${t.capability}] ${t.title}${t.decision ? ` — needs decision: ${t.decision}` : ""}`);
  const contract: Omit<HumainContract, "sessionId"> = {
    desired: plan.idea,
    observed: observed.facts,
    satisfied,
    modifications,
    missing: capabilities.build.map((b) => `${b.capability}: ${b.why}`),
    acceptance,
    limits: { spendCeilingUsd: null, computeDeadlineSecs: null }, // filled at approval
  };
  return { contract, frameTasks };
}
