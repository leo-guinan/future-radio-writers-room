// Observed state: inspect the actual repository/registry, run acceptance checks,
// and recompute the remaining delta. The reconcile loop calls this after every
// meaningful action and chooses the next action from what it finds.

import { listFrames, peekFrame, readFrame } from "./frames.ts";
import { feedbackCoverage, loadTake, preservedLines, validateEdits } from "./cuts.ts";
import { RestrictedWorkspace } from "./executor.ts";
import type { HumainAcceptanceTest, HumainContract, HumainTaskResult } from "../core/types.ts";

/** Parse a cut check target like "going-viral:take1". Fails closed on garbage. */
function parseCutExpected(expected: string): { episode: string; take: number } {
  const m = expected.match(/^([a-z0-9][a-z0-9-]*):take(\d+)$/);
  if (!m) throw new Error(`bad cut reference ${JSON.stringify(expected)} (want episode:takeN)`);
  return { episode: m[1], take: Number(m[2]) };
}

function readRevision(sessionId: string): { feedback: Array<{ id: string; point: string }>; edits: any[]; declined: Array<{ fixes: string; reason: string }>; reuse?: { preserved: number; total: number }; rewriteCount?: number } {
  const rev = JSON.parse(RestrictedWorkspace.open(sessionId).readFile("edits.json"));
  if (!Array.isArray(rev?.feedback) || !Array.isArray(rev?.edits) || !Array.isArray(rev?.declined))
    throw new Error("edits.json lacks feedback/edits/declined arrays");
  return rev;
}

export interface ObservedState {
  facts: string[]; // observed facts, each carrying its evidence
  frames: Array<{ frameId: string; hook: string; counts: { human: number; unique: number; verification: number }; sha256: string }>;
  workspaceFiles: string[];
}

export function observeState(sessionId: string): ObservedState {
  const frames = listFrames().map((f) => ({ frameId: f.frameId, hook: f.hook, counts: f.counts, sha256: f.sha256 }));
  let workspaceFiles: string[] = [];
  try {
    workspaceFiles = RestrictedWorkspace.open(sessionId).list();
  } catch {
    workspaceFiles = [];
  }
  const facts = [
    `registry holds ${frames.length} frame(s)${frames.length ? `: ${frames.map((f) => `${f.frameId} "${f.hook.slice(0, 40)}" (${f.counts.human} human/${f.counts.unique} unique/${f.counts.verification} verification, sha256:${f.sha256.slice(0, 12)})`).join("; ")}` : " (evidence: frames registry scan)"}`,
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
      case "cut.edits_valid": {
        const { episode, take } = parseCutExpected(t.expected);
        const { cut } = loadTake(episode, take);
        const rev = readRevision(sessionId);
        const errs = validateEdits(cut, rev.edits, rev.feedback.map((f) => f.id), rev.declined);
        return errs.length === 0
          ? { id: t.id, pass: true, detail: `${rev.edits.length} edits validate against take ${take}` }
          : fail(errs.join("; "));
      }
      case "cut.feedback_addressed": {
        const rev = readRevision(sessionId);
        const { uncovered, double } = feedbackCoverage(rev.feedback, rev.edits, rev.declined);
        return uncovered.length === 0 && double.length === 0
          ? { id: t.id, pass: true, detail: `${rev.feedback.length} feedback point(s) fixed or declined` }
          : fail([...uncovered.map((id) => `${id} unaddressed`), ...double.map((id) => `${id} both fixed and declined`)].join("; "));
      }
      case "cut.edit_count": {
        const rev = readRevision(sessionId);
        const max = Number(t.expected);
        return rev.edits.length <= max
          ? { id: t.id, pass: true, detail: `${rev.edits.length} edits within ${max}` }
          : fail(`${rev.edits.length} edits exceed ${max}`);
      }
      case "cut.reuse_reported": {
        const { episode, take } = parseCutExpected(t.expected);
        const { cut } = loadTake(episode, take);
        const ws = RestrictedWorkspace.open(sessionId);
        const rev = readRevision(sessionId);
        const next = JSON.parse(ws.readFile(`take${take + 1}.cut.json`));
        const { preserved, total } = preservedLines(cut, next);
        if (rev.reuse?.preserved !== preserved || rev.reuse?.total !== total)
          return fail(`edits.json reuse ${rev.reuse?.preserved}/${rev.reuse?.total} disagrees with recomputed ${preserved}/${total}`);
        const diff = ws.readFile("diff.md");
        const line = `${preserved}/${total} lines reused`;
        if (!diff.includes(line)) return fail(`diff.md lacks the reuse line (${line})`);
        const missing = rev.edits.filter((e) => typeof e?.op !== "string" || !diff.includes(e.op));
        if (missing.length) return fail(`diff.md lacks before/after for ${missing.length} edit(s)`);
        return { id: t.id, pass: true, detail: `${line}; diff covers ${rev.edits.length} edits` };
      }
      case "cut.voice_booked": {
        const rev = readRevision(sessionId);
        const booked = Number(t.expected);
        return rev.rewriteCount === booked
          ? { id: t.id, pass: true, detail: `${booked} new recording(s) booked` }
          : fail(`edits.json books ${rev.rewriteCount}, contract booked ${booked}`);
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
