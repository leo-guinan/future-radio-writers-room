// Live code-change session driver, typed variant (no voice file).
// Usage: MODEL_API_KEY=... DATA_DIR=... HUMAIN_LIVE=1 node --import tsx humain-code-session2.mjs "<idea>" <ceiling> <secs> <reserve>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
process.chdir(ROOT);
const [ideaArg, ceilingS, secsS, reserveS] = process.argv.slice(2);
if (!ideaArg) throw new Error("usage: humain-code-session2.mjs <idea> <ceiling> <secs> <reserve>");
const { openRoom } = await import(`${ROOT}/src/core/open.ts`);
const { SessionController } = await import(`${ROOT}/src/humain/session.ts`);
const { SparkPlanner } = await import(`${ROOT}/src/humain/adapters.ts`);
const { inventory } = await import(`${ROOT}/src/humain/capabilities.ts`);
const { bookEstimate, estimatePlan } = await import(`${ROOT}/src/humain/estimate.ts`);
const { observeState } = await import(`${ROOT}/src/humain/observe.ts`);

const room = openRoom();
const actor = "leo";
const s = SessionController.open(room, actor, 2, true, Number(reserveS ?? 10));
console.log(`SESSION ${s.sessionId} reserved ${s.reserveMin}min of 60`);
s.startRecording("reuse test: typed request");
s.ingestTranscript(ideaArg, true, "typed-fallback");
s.closeInput("reuse test: request captured");
const idea = s.ideaText();
console.log(`IDEA: ${idea}`);

const inv = inventory(ROOT);
const observed = observeState(s.sessionId);
const code = readFileSync(`${ROOT}/src/humain/frames.ts`, "utf8").slice(0, 3000)
  + "\n--- routes excerpt ---\n" + readFileSync(`${ROOT}/src/humain/routes.ts`, "utf8").slice(0, 3000);
const planner = new SparkPlanner();
console.log(`planning via ${planner.id} ...`);
const pc = await planner.planCode(idea, { facts: observed.facts, reuse: inv.reuse, code });
console.log(`SPARK provider=meta model=muse-spark-1.3 tokens=${pc.usage.input}/${pc.usage.output} cost=${pc.costUsd === null ? "unknown" : "$" + pc.costUsd}`);
if (typeof pc.costUsd === "number" && pc.costUsd > 0)
  room.addLedgerEntry(actor, { ledger: "operations", kind: "expense", amount: pc.costUsd, unit: "usd", status: "observed", label: `muse-spark-1.3 ${s.sessionId}`, evidence: s.sessionId }, "producer");
else if (pc.usage.input + pc.usage.output > 0)
  room.addLedgerEntry(actor, { ledger: "operations", kind: "expense", amount: pc.usage.input + pc.usage.output, unit: "tokens", status: "unknown", label: `muse-spark-1.3 ${s.sessionId} (unpriced)`, evidence: s.sessionId }, "producer");

const d = pc.draft;
const plan = s.recordPlan({
  idea, hook: d.desired.slice(0, 140), planner: planner.id,
  tasks: d.modifications.map((m, i) => ({
    taskId: `${s.sessionId}-T${i + 1}`, title: m.title.slice(0, 120), kind: "build",
    capability: "code.change", detail: m.detail.slice(0, 2000),
    estApiUsd: 0, estHours: Number(m.estHours) || 0.5, estSeconds: 600,
  })),
});
s.recordCapabilities({ reuse: d.reusable.slice(0, 12).map((r) => ({ capability: String(r.capability).slice(0, 80), source: String(r.source).slice(0, 120), evidence: String(r.evidence).slice(0, 200) })), build: d.missing.map((x) => ({ capability: String(x).slice(0, 120), why: "named missing by the contract" })) });
const est = estimatePlan(plan);
const recorded = s.recordEstimate({ ...est, forecastId: bookEstimate(room, actor, s.sessionId, est) });
const acceptance = d.acceptance.map((a, i) => ({
  id: `${s.sessionId}-A${i + 1}`, description: String(a.description).slice(0, 200),
  check: String(a.check).slice(0, 40),
  target: String(a.target).replace(/TASK(\d+)/g, (_, n) => `${s.sessionId}-T${n}`).slice(0, 60),
  expected: String(a.expected).slice(0, 200),
}));
s.recordContract({
  desired: d.desired.slice(0, 2000), observed: observed.facts,
  satisfied: d.satisfied.map((x) => String(x).slice(0, 300)),
  modifications: plan.tasks.map((x) => `${x.taskId} ${x.title}`),
  missing: d.missing.map((x) => String(x).slice(0, 200)),
  acceptance, limits: { spendCeilingUsd: null, computeDeadlineSecs: null },
}, []);
s.approve(Number(ceilingS ?? 5), Number(secsS ?? 1800));
console.log(`APPROVED ceiling=$${ceilingS ?? 5} compute=${secsS ?? 1800}s`);
s.beginExecution();
console.log(`CONTRACT desired: ${d.desired.slice(0, 200)}`);
console.log(`TASKS:\n${plan.tasks.map((x) => `  ${x.taskId} ${x.title}`).join("\n")}`);
console.log(`ACCEPTANCE:\n${acceptance.map((a) => `  ${a.id} [${a.check}] ${a.description} (target ${a.target})`).join("\n")}`);
console.log(`ESTIMATE $${est.apiUsd} API ${est.localHours}h ${est.executionSeconds}s`);
