// Observed state: inspect the actual repository/registry, run acceptance checks,
// and recompute the remaining delta. The reconcile loop calls this after every
// meaningful action and chooses the next action from what it finds.

import { listFrames, peekFrame, readFrame } from "./frames.ts";
import { RestrictedWorkspace } from "./executor.ts";
import type { HumainAcceptanceTest, HumainContract, HumainTaskResult } from "../core/types.ts";

export interface ObservedState {
  facts: string[]; // observed facts, each carrying its evidence
  frames: Array<{ frameId: string; hook: string; visits: number; sha256: string }>;
  workspaceFiles: string[];
}

export function observeState(sessionId: string): ObservedState {
  const frames = listFrames().map((f) => ({ frameId: f.frameId, hook: f.hook, visits: f.visits, sha256: f.sha256 }));
  let workspaceFiles: string[] = [];
  try {
    workspaceFiles = RestrictedWorkspace.open(sessionId).list();
  } catch {
    workspaceFiles = [];
  }
  const facts = [
    `registry holds ${frames.length} frame(s)${frames.length ? `: ${frames.map((f) => `${f.frameId} "${f.hook.slice(0, 40)}" (${f.visits} visits, sha256:${f.sha256.slice(0, 12)})`).join("; ")}` : " (evidence: frames registry scan)"}`,
    `workspace ${sessionId} holds ${workspaceFiles.length} file(s)${workspaceFiles.length ? `: ${workspaceFiles.join(", ")}` : ""} (evidence: workspace list)`,
  ];
  return { facts, frames, workspaceFiles };
}

export interface CheckOutcome {
  id: string;
  pass: boolean;
  detail: string;
}

/** Run one acceptance test against actual state. Verification views count as visits. */
export function runAcceptance(t: HumainAcceptanceTest, sessionId: string, results: HumainTaskResult[]): CheckOutcome {
  const fail = (detail: string): CheckOutcome => ({ id: t.id, pass: false, detail });
  try {
    switch (t.check) {
      case "frame.exists": {
        readFrame(t.target);
        return { id: t.id, pass: true, detail: `${t.target} exists in the registry` };
      }
      case "frame.hook": {
        const { html, meta } = readFrame(t.target);
        const esc = t.expected.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        return html.includes(esc) || meta.hook === t.expected
          ? { id: t.id, pass: true, detail: `${t.target} carries its hook` }
          : fail(`${t.target} does not carry expected hook`);
      }
      case "frame.counter": {
        const { html } = readFrame(t.target);
        return html.includes('data-testid="visitor-counter"')
          ? { id: t.id, pass: true, detail: `${t.target} has a visitor counter` }
          : fail(`${t.target} has no visitor counter`);
      }
      case "frame.works": {
        const { html } = readFrame(t.target);
        const [a, b] = t.expected.split(",");
        return html.includes(`data-work="${a}"`) && html.includes(`data-work="${b}"`)
          ? { id: t.id, pass: true, detail: `${t.target} compares ${a} and ${b}` }
          : fail(`${t.target} does not compare ${t.expected}`);
      }
      case "frame.serves": {
        // Peek, never serve: verification must not inflate visitor counts.
        const { html } = peekFrame(t.target);
        return html.includes("<html")
          ? { id: t.id, pass: true, detail: `${t.target} serves its page (verified without counting a visit)` }
          : fail(`${t.target} serves no page`);
      }
      case "catalog.reused": {
        const r = results.find((x) => x.taskId === t.target && x.status === "success" && x.evidence);
        return r ? { id: t.id, pass: true, detail: `${t.target} reused catalog (${r.evidence})` } : fail(`${t.target} has no evidenced reuse result`);
      }
      case "task.evidence": {
        const r = results.find((x) => x.taskId === t.target && x.status === "success" && x.evidence);
        return r ? { id: t.id, pass: true, detail: `${t.target} completed with evidence` } : fail(`${t.target} has no evidenced success result`);
      }
      case "workspace.file": {
        const ws = RestrictedWorkspace.open(sessionId);
        return ws.exists(t.expected)
          ? { id: t.id, pass: true, detail: `${t.expected} present in workspace` }
          : fail(`${t.expected} missing from workspace`);
      }
      default:
        return fail(`unknown check ${t.check}`);
    }
  } catch (e: any) {
    return fail(`${t.check} on ${t.target}: ${e?.message ?? e}`);
  }
}

/** The remaining delta: acceptance tests not currently passing. */
export function remainingDelta(contract: HumainContract, sessionId: string, results: HumainTaskResult[]): CheckOutcome[] {
  return contract.acceptance
    .map((t) => runAcceptance(t, sessionId, results))
    .filter((o) => !o.pass);
}

export function acceptanceSummary(contract: HumainContract, sessionId: string, results: HumainTaskResult[]): { passed: string[]; failed: string[] } {
  const passed: string[] = [];
  const failed: string[] = [];
  for (const t of contract.acceptance) (runAcceptance(t, sessionId, results).pass ? passed : failed).push(t.id);
  return { passed, failed };
}
