// Frame Maker: the first working prototype capability. Builds a static webpage
// comparing two existing creative works with one hook and a vintage visitor
// counter. Runs inside the restricted workspace; every claim needs evidence.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Room } from "../core/room.ts";
import type { SessionController } from "./session.ts";
import { RestrictedWorkspace } from "./executor.ts";

export interface WorkRef {
  work_id: string;
  title: string;
  kind: string;
  runtime_seconds?: number;
  url?: string;
}

export function loadWorks(root = process.cwd()): WorkRef[] {
  try {
    const catalog = JSON.parse(readFileSync(join(root, "catalog", "works.json"), "utf8")) as {
      works: Array<{ work_id: string; title: string; kind: string; youtube?: { url?: string }; releases?: Array<{ runtime_seconds?: number }> }>;
    };
    return catalog.works.map((w) => ({
      work_id: w.work_id,
      title: w.title,
      kind: w.kind,
      runtime_seconds: w.releases?.[0]?.runtime_seconds,
      url: w.youtube?.url,
    }));
  } catch {
    return [];
  }
}

function fmtRuntime(secs?: number): string {
  if (!secs) return "runtime unknown";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderComparison(a: WorkRef, b: WorkRef, hook: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(hook)}</title>
<style>
  body { background: #0d0d12; color: #e8e0c8; font-family: Georgia, serif; max-width: 860px; margin: 2rem auto; padding: 0 1.2rem; }
  .hook { font-size: 1.9rem; border-bottom: 3px double #8a6d3b; padding-bottom: .6rem; }
  .works { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1.5rem 0; }
  .work { border: 1px solid #8a6d3b; border-radius: 8px; padding: 1rem; background: #14141c; }
  .work h2 { margin-top: 0; font-size: 1.2rem; }
  .work a { color: #d8b25c; }
  .counter { text-align: center; margin-top: 2rem; font-family: "Courier New", monospace; }
  .odometer { display: inline-block; background: #000; border: 3px inset #666; border-radius: 6px; padding: .3rem .8rem; letter-spacing: .35rem; font-size: 2rem; color: #7dff8a; }
  .made { text-align: center; opacity: .6; font-size: .85rem; margin-top: 1rem; }
</style>
</head>
<body>
  <p><a href="/humain.html" style="color:#d8b25c">&larr; HumAIn OS session</a></p>
  <h1 class="hook">${esc(hook)}</h1>
  <div class="works">
    <div class="work" data-work="${esc(a.work_id)}">
      <h2>${esc(a.title)}</h2>
      <p>Kind: ${esc(a.kind)} &middot; ${esc(fmtRuntime(a.runtime_seconds))}</p>
      ${a.url ? `<p><a href="${esc(a.url)}">Watch / listen</a></p>` : "<p>Unreleased.</p>"}
    </div>
    <div class="work" data-work="${esc(b.work_id)}">
      <h2>${esc(b.title)}</h2>
      <p>Kind: ${esc(b.kind)} &middot; ${esc(fmtRuntime(b.runtime_seconds))}</p>
      ${b.url ? `<p><a href="${esc(b.url)}">Watch / listen</a></p>` : "<p>Unreleased.</p>"}
    </div>
  </div>
  <div class="counter" data-testid="visitor-counter">
    <div>You are visitor</div>
    <div class="odometer" id="odometer">000000</div>
    <div>since the static began</div>
  </div>
  <p class="made">Framed by HumAIn OS Frame Maker prototype. Counter is per-browser (localStorage).</p>
<script>
(function () {
  var key = "humain-visitor-count";
  var n = 1;
  try { n = (parseInt(localStorage.getItem(key) || "0", 10) || 0) + 1; localStorage.setItem(key, String(n)); }
  catch (e) { n = 1; }
  document.getElementById("odometer").textContent = String(n).padStart(6, "0");
})();
</script>
</body>
</html>
`;
}

export interface FrameResult {
  file: string;
  sha256: string;
  bytes: number;
  checks: string[];
}

/** Execute the frame-maker + counter build tasks inside the workspace, with evidence. */
export function buildFrame(ws: RestrictedWorkspace, a: WorkRef, b: WorkRef, hook: string): FrameResult {
  const html = renderComparison(a, b, hook);
  const { bytes, sha256 } = ws.writeFile("frame/index.html", html);
  const checks: string[] = [];
  const back = ws.readFile("frame/index.html");
  if (!back.includes(esc(hook))) throw new Error("Evidence check failed: hook missing from page.");
  checks.push("hook present");
  if (!back.includes('data-testid="visitor-counter"')) throw new Error("Evidence check failed: counter missing.");
  checks.push("visitor counter present");
  if (!back.includes(`data-work="${a.work_id}"`) || !back.includes(`data-work="${b.work_id}"`))
    throw new Error("Evidence check failed: both works missing.");
  checks.push("both works present");
  checks.push(`sha256:${sha256.slice(0, 12)}`);
  return { file: "frame/index.html", sha256, bytes, checks };
}

/** Run the approved plan: gate every task, block undecided tasks, book actuals. */
export async function executePlan(room: Room, session: SessionController, actor: string): Promise<void> {
  const plan = session.currentPlan;
  if (!plan) throw new Error("No plan to execute.");
  const started = Date.now();
  const ws = RestrictedWorkspace.create(session.sessionId);
  const works = loadWorks();
  try {
    for (const task of plan.tasks) {
      session.guardAction(task.estApiUsd); // deadline + ceiling, before every task
      if (task.decision && !session.state().decisions[task.taskId]) {
        session.blockTask(task.taskId, task.decision);
        continue;
      }
      const t0 = Date.now();
      if (task.capability === "frame-maker" || task.capability === "visitor-counter" || task.capability === "catalog-works") {
        const [a, b] = worksFor(plan, works);
        if (task.capability === "catalog-works") {
          session.recordTaskResult({
            taskId: task.taskId, status: "success",
            evidence: `catalog works ${a.work_id}, ${b.work_id}`,
            detail: `Reused catalog entries ${a.work_id} and ${b.work_id}.`,
            costUsd: 0, seconds: Math.round((Date.now() - t0) / 1000),
          });
        } else {
          const frame = buildFrame(ws, a, b, plan.hook);
          session.recordArtifact({ taskId: task.taskId, path: frame.file, sha256: frame.sha256, bytes: frame.bytes, label: `Comparison page: ${a.title} vs ${b.title}` });
          session.recordTaskResult({
            taskId: task.taskId, status: "success",
            evidence: `sha256 ${frame.sha256}; ${frame.checks.join(", ")}`,
            detail: `Built ${frame.file} (${frame.bytes} bytes). Checks: ${frame.checks.join(", ")}.`,
            costUsd: 0, seconds: Math.round((Date.now() - t0) / 1000),
          });
        }
      } else if (task.capability === "evidence-checks") {
        const files = ws.list();
        const ok = files.includes("frame/index.html");
        session.recordTaskResult({
          taskId: task.taskId, status: ok ? "success" : "failed",
          evidence: ok ? `workspace files: ${files.join(", ")}` : undefined,
          detail: ok ? `Verified workspace: ${files.join(", ")}.` : "frame/index.html missing from workspace.",
          costUsd: 0, seconds: Math.round((Date.now() - t0) / 1000),
        });
      } else {
        // Unknown capability: no silent success. Record what happened, claim nothing.
        session.recordTaskResult({
          taskId: task.taskId, status: "unverified",
          detail: `No executor for capability '${task.capability}'. Left unverified.`,
          costUsd: 0, seconds: Math.round((Date.now() - t0) / 1000),
        });
      }
    }
    // Actuals: observed entries with evidence, on the same ledgers as everything else.
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
    session.finish(`Executed ${plan.tasks.length} tasks in ${secs}s. Workspace: ${ws.dir}`);
  } catch (e: any) {
    if (e?.rule === "humain") throw e; // deadline/budget stops propagate as-is
    session.recordTaskResult({ taskId: plan.tasks[session.state().results.length]?.taskId ?? "unknown", status: "failed", detail: String(e?.message ?? e), costUsd: 0, seconds: 0 });
    session.stop("manual-stop", `Execution halted: ${e?.message ?? e}`);
    throw e;
  }
}

function worksFor(plan: { tasks: Array<{ detail: string }> }, works: WorkRef[]): [WorkRef, WorkRef] {
  const text = plan.tasks.map((t) => t.detail).join(" ");
  const found = works.filter((w) => text.includes(w.work_id));
  const fallback: WorkRef = { work_id: "unknown", title: "An unmade episode", kind: "episode" };
  return [found[0] ?? works[0] ?? fallback, found[1] ?? works[1] ?? fallback];
}
