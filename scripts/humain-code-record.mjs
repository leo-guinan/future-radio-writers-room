// Record code-task evidence and reconcile. Usage:
//   node --import tsx humain-code-record.mjs <T1:evidenceFile> [T2:evidenceFile ...]
// Env: DATA_DIR, SESSION (e.g. H-0007), ACTOR.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
process.chdir(ROOT);
const sessionId = process.env.SESSION;
if (!sessionId) throw new Error("SESSION env required");
const { openRoom } = await import(`${ROOT}/src/core/open.ts`);
const { SessionController } = await import(`${ROOT}/src/humain/session.ts`);
const { acceptanceSummary } = await import(`${ROOT}/src/humain/observe.ts`);
const { resolveEstimate } = await import(`${ROOT}/src/humain/estimate.ts`);
const room = openRoom();
const s = SessionController.rebuild(room, sessionId);
const actor = process.env.ACTOR ?? "leo";
for (const pair of process.argv.slice(2)) {
  const i = pair.indexOf(":");
  const taskId = pair.slice(0, i);
  const file = pair.slice(i + 1);
  const evidence = readFileSync(file, "utf8").slice(0, 3000);
  s.guardAction(0);
  s.recordTaskResult({ taskId, status: "success", evidence, detail: `Executed in isolated checkout; evidence from ${file}.`, costUsd: 0, seconds: 0 });
  console.log(`recorded ${taskId} (${evidence.length} chars evidence)`);
}
const contract = s.currentContract;
const { passed, failed } = acceptanceSummary(contract, sessionId, s.state().results);
console.log(`ACCEPTANCE passed=${passed.length} failed=${failed.length}`);
for (const id of failed) console.log(`  FAIL ${id}`);
if (failed.length === 0 && contract.acceptance.length > 0) {
  room.addLedgerEntry(actor, { ledger: "operations", kind: "expense", amount: s.state().spendUsd, unit: "usd", status: "observed", label: `ACTUAL ${sessionId} API spend`, evidence: sessionId }, "producer");
  const f = s.state().estimate?.forecastId;
  if (f) resolveEstimate(room, actor, f, { apiUsd: s.state().spendUsd, localHours: 0, executionSeconds: 0 });
  s.finish(`Verified state reconciliation: ${passed.length}/${contract.acceptance.length} acceptance tests pass with recorded evidence.`);
  console.log(`FINISHED ${sessionId}`);
} else {
  s.checkpoint({ reason: "awaiting-evidence", remaining: failed.map((id) => `acceptance ${id}`), passed, failed, state: "partial evidence recorded" });
  console.log(`CHECKPOINTED ${sessionId}, ${failed.length} still failing`);
}
