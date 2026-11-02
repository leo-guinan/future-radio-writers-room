// The trusted session controller. Every deadline, budget and revocation is enforced
// here, in code, outside any model prompt. State changes are appended to the same
// event log the writers' room replays.

import { Deadline } from "./clock.ts";
import { RuleError } from "../core/room.ts";
import type { Room } from "../core/room.ts";
import type {
  HumainApproved,
  HumainArtifact,
  HumainCapabilities,
  HumainDecision,
  HumainEstimate,
  HumainPlan,
  HumainPlanTask,
  HumainSessionOpened,
  HumainStopped,
  HumainTaskBlocked,
  HumainTaskResult,
  HumainTranscript,
} from "../core/types.ts";

export const INPUT_WINDOWS = [2, 5, 15, 60] as const;
export const MAX_COMPUTE_SECS = 60 * 60;

export type SessionPhase =
  | "listening" // input window open; recording only when the user explicitly started it
  | "input-closed" // no more human input, ever again for this session
  | "planned"
  | "approved"
  | "executing"
  | "terminal";

export interface SessionState {
  sessionId: string;
  phase: SessionPhase;
  recording: boolean;
  inputWindowMin: number;
  inputRemainingMs: number;
  inputClosed: boolean;
  transcriptChars: number;
  transcriptChunks: number;
  transcriptSaved: boolean; // false = memory-only (no permission) or lost on restart
  plan: HumainPlan | null;
  capabilities: HumainCapabilities | null;
  estimate: HumainEstimate | null;
  approval: HumainApproved | null;
  computeRemainingMs: number | null;
  spendUsd: number;
  decisions: Record<string, string>; // taskId -> resolution
  blocked: string[];
  results: HumainTaskResult[];
  artifacts: HumainArtifact[];
  terminal: HumainStopped | null;
}

export class SessionController {
  private phase: SessionPhase = "listening";
  private recording = false;
  private inputDeadline: Deadline;
  private computeDeadline: Deadline | null = null;
  private transcript: HumainTranscript[] = [];
  private plan: HumainPlan | null = null;
  private capabilities: HumainCapabilities | null = null;
  private estimate: HumainEstimate | null = null;
  private approval: HumainApproved | null = null;
  private spendUsd = 0;
  private decisions: Record<string, string> = {};
  private blocked: string[] = [];
  private results: HumainTaskResult[] = [];
  private artifacts: HumainArtifact[] = [];
  private terminal: HumainStopped | null = null;

  private constructor(
    readonly room: Room,
    readonly sessionId: string,
    readonly actor: string,
    readonly inputWindowMin: number,
    readonly saveTranscript: boolean,
    inputDeadline: Deadline,
  ) {
    this.inputDeadline = inputDeadline;
  }

  static open(room: Room, actor: string, inputWindowMin: number, saveTranscript: boolean): SessionController {
    if (!(INPUT_WINDOWS as readonly number[]).includes(inputWindowMin))
      throw new RuleError("humain", `Pick a human input window: ${INPUT_WINDOWS.join(", ")} minutes.`);
    const n = room.store.all().filter((e) => e.type === "humain.session_opened").length + 1;
    const sessionId = `H-${String(n).padStart(4, "0")}`;
    const deadline = Deadline.in(inputWindowMin * 60_000);
    const opened: HumainSessionOpened = {
      sessionId,
      inputWindowMin,
      inputDeadlineWall: deadline.atWallIso,
      saveTranscript,
    };
    room.store.append("humain.session_opened", actor, opened, "public");
    return new SessionController(room, sessionId, actor, inputWindowMin, saveTranscript, deadline);
  }

  /** Rebuild a controller from the log (e.g. after a restart). Memory-only transcripts are gone; the log says so. */
  static rebuild(room: Room, sessionId: string): SessionController {
    const events = room.store.all().filter((e) => e.type.startsWith("humain.") && (e.payload as any).sessionId === sessionId);
    const opened = events.find((e) => e.type === "humain.session_opened");
    if (!opened) throw new RuleError("humain", `No session ${sessionId}.`);
    const p = opened.payload as HumainSessionOpened;
    const c = new SessionController(room, sessionId, opened.actor, p.inputWindowMin, p.saveTranscript, Deadline.fromWallIso(p.inputDeadlineWall));
    for (const e of events) {
      const q = e.payload as any;
      switch (e.type) {
        case "humain.recording_started":
          c.recording = true;
          break;
        case "humain.recording_stopped":
          c.recording = false;
          break;
        case "humain.transcript":
          c.transcript.push(q as HumainTranscript);
          break;
        case "humain.plan":
          c.plan = q as HumainPlan;
          c.phase = "planned";
          break;
        case "humain.capabilities":
          c.capabilities = q as HumainCapabilities;
          break;
        case "humain.estimate":
          c.estimate = q as HumainEstimate;
          break;
        case "humain.approved":
          c.approval = q as HumainApproved;
          c.computeDeadline = Deadline.fromWallIso(q.computeDeadlineWall);
          c.phase = "approved";
          break;
        case "humain.task_blocked":
          c.blocked.push((q as HumainTaskBlocked).taskId);
          break;
        case "humain.task_result": {
          const r = q as HumainTaskResult;
          c.results.push(r);
          c.phase = "executing";
          if (typeof r.costUsd === "number") c.spendUsd += r.costUsd;
          break;
        }
        case "humain.artifact":
          c.artifacts.push(q as HumainArtifact);
          break;
        case "humain.decision":
          c.decisions[(q as HumainDecision).taskId] = (q as HumainDecision).resolution;
          break;
        case "humain.stopped":
          c.terminal = q as HumainStopped;
          c.phase = "terminal";
          c.recording = false;
          break;
      }
    }
    // A restart never reopens input or recording: capture stays stopped.
    c.recording = false;
    if (c.inputDeadline.expired() && c.phase === "listening") c.phase = "input-closed";
    if (c.phase === "listening" && c.transcript.length && !p.saveTranscript) c.phase = c.phase; // memory transcripts, still listenable
    return c;
  }

  // ---------------- input lifecycle ----------------

  /** The user explicitly starts microphone capture. Nothing else may start it. */
  startRecording(reason: string): void {
    this.assertActive();
    this.closeInputIfExpired();
    if (this.phase !== "listening") throw new RuleError("humain", "This session is no longer listening. Recording cannot restart.");
    if (this.recording) throw new RuleError("humain", "Already recording.");
    this.recording = true;
    this.room.store.append("humain.recording_started", this.actor, { sessionId: this.sessionId, reason }, "public");
  }

  stopRecording(reason: string): void {
    if (!this.recording) return; // stopping is always safe, never an error
    this.recording = false;
    this.room.store.append("humain.recording_stopped", this.actor, { sessionId: this.sessionId, reason }, "public");
  }

  /** True when the input window has passed; capture stops and input closes. Never restarts. */
  closeInputIfExpired(): boolean {
    if (this.phase !== "listening" || !this.inputDeadline.expired()) return false;
    this.stopRecording("input deadline reached — capture stopped, transcription connection closed");
    this.phase = "input-closed";
    if (this.transcript.length === 0 && !this.plan) {
      this.terminal = { sessionId: this.sessionId, reason: "input-deadline", detail: "The input window closed with no spoken input captured." };
      this.phase = "terminal";
      this.room.store.append("humain.stopped", "system", this.terminal, "public");
    }
    return true;
  }

  /** The user finished speaking early. Input closes permanently. */
  closeInput(reason: string): void {
    this.assertActive();
    if (this.phase !== "listening") return;
    this.stopRecording(reason);
    this.phase = "input-closed";
  }

  get isRecording(): boolean {
    this.closeInputIfExpired();
    return this.recording;
  }

  /** Live transcript chunk. Rejected after the input deadline; saved only with permission. */
  ingestTranscript(text: string, final: boolean, source: string): HumainTranscript | null {
    this.assertActive();
    if (this.closeInputIfExpired() || this.phase !== "listening")
      throw new RuleError("humain", "The input window is closed. No more human input is accepted.");
    const clean = text.trim().slice(0, 4000);
    if (!clean) return null;
    const chunk: HumainTranscript = { sessionId: this.sessionId, n: this.transcript.length + 1, text: clean, final, source };
    this.transcript.push(chunk);
    if (this.saveTranscript) this.room.store.append("humain.transcript", this.actor, chunk, "producer");
    return chunk;
  }

  ideaText(): string {
    return this.transcript
      .filter((t) => t.final)
      .map((t) => t.text)
      .join(" ")
      .trim();
  }

  // ---------------- plan / estimate / approve ----------------

  recordPlan(plan: Omit<HumainPlan, "sessionId">): HumainPlan {
    this.assertActive();
    if (this.phase === "listening") throw new RuleError("humain", "Close the input window before planning.");
    if (!plan.tasks.length) throw new RuleError("humain", "A plan needs at least one task.");
    const full: HumainPlan = { ...plan, sessionId: this.sessionId };
    this.plan = full;
    this.phase = "planned";
    this.room.store.append("humain.plan", "system", full, "public");
    return full;
  }

  recordCapabilities(caps: Omit<HumainCapabilities, "sessionId">): void {
    this.assertActive();
    if (!this.plan) throw new RuleError("humain", "Plan first, then inventory capabilities.");
    this.capabilities = { ...caps, sessionId: this.sessionId };
    this.room.store.append("humain.capabilities", "system", this.capabilities, "public");
  }

  recordEstimate(est: Omit<HumainEstimate, "sessionId" | "label">): HumainEstimate {
    this.assertActive();
    if (!this.plan) throw new RuleError("humain", "Plan first, then estimate.");
    const full: HumainEstimate = { ...est, sessionId: this.sessionId, label: "ESTIMATE" };
    this.estimate = full;
    this.room.store.append("humain.estimate", "system", full, "public");
    return full;
  }

  /** The user approves autonomous execution with a hard spend ceiling and compute deadline. */
  approve(spendCeilingUsd: number, computeDeadlineSecs: number): HumainApproved {
    this.assertActive();
    if (!this.plan || !this.estimate) throw new RuleError("humain", "Approve a planned, estimated session.");
    if (!(spendCeilingUsd >= 0) || !Number.isFinite(spendCeilingUsd)) throw new RuleError("humain", "The spending ceiling must be a non-negative number.");
    if (!(computeDeadlineSecs > 0) || computeDeadlineSecs > MAX_COMPUTE_SECS)
      throw new RuleError("humain", `The compute deadline must be 1–${MAX_COMPUTE_SECS} seconds.`);
    this.computeDeadline = Deadline.in(computeDeadlineSecs * 1000);
    const approval: HumainApproved = {
      sessionId: this.sessionId,
      spendCeilingUsd,
      computeDeadlineSecs,
      computeDeadlineWall: this.computeDeadline.atWallIso,
    };
    this.approval = approval;
    this.phase = "approved";
    this.room.store.append("humain.approved", this.actor, approval, "public");
    return approval;
  }

  resolveDecision(taskId: string, resolution: string, by: string): void {
    this.assertActive();
    if (!resolution.trim()) throw new RuleError("humain", "A resolution says what was decided.");
    const d: HumainDecision = { sessionId: this.sessionId, taskId, decision: this.plan?.tasks.find((t) => t.taskId === taskId)?.decision ?? "", resolution: resolution.trim(), by };
    this.decisions[taskId] = d.resolution;
    this.room.store.append("humain.decision", by, d, "public");
  }

  // ---------------- execution gating ----------------

  /** Every action passes through here. Throws after the compute deadline or over budget. */
  guardAction(costUsd: number | null): void {
    this.assertActive();
    if (!this.approval || !this.computeDeadline) throw new RuleError("humain", "Execution needs an approved plan first.");
    if (this.computeDeadline.expired()) {
      this.finishTerminal("compute-deadline", "The compute deadline passed; remaining actions are rejected.");
      throw new RuleError("humain", "The compute deadline passed. No further actions.");
    }
    if (typeof costUsd === "number" && this.spendUsd + costUsd > this.approval.spendCeilingUsd + 1e-9) {
      this.finishTerminal("budget", `Spend $${(this.spendUsd + costUsd).toFixed(2)} would pass the $${this.approval.spendCeilingUsd.toFixed(2)} ceiling.`);
      throw new RuleError("humain", "The spending ceiling refuses this action.");
    }
  }

  blockTask(taskId: string, decision: string): void {
    if (this.blocked.includes(taskId)) return;
    this.blocked.push(taskId);
    const b: HumainTaskBlocked = { sessionId: this.sessionId, taskId, decision };
    this.room.store.append("humain.task_blocked", "system", b, "public");
    this.recordTaskResult({ taskId, status: "blocked", detail: `Blocked on a pending decision: ${decision}`, costUsd: 0, seconds: 0 });
  }

  /** Success without evidence is refused: the claim is recorded as unverified instead. */
  recordTaskResult(r: Omit<HumainTaskResult, "sessionId">): HumainTaskResult {
    this.assertActive();
    let status = r.status;
    let detail = r.detail;
    if (status === "success" && !r.evidence) {
      status = "unverified";
      detail = `${r.detail} (claimed success without evidence; recorded as unverified)`;
    }
    const full: HumainTaskResult = { ...r, status, detail, sessionId: this.sessionId };
    this.results.push(full);
    if (this.phase === "approved") this.phase = "executing";
    if (typeof r.costUsd === "number") this.spendUsd += r.costUsd;
    this.room.store.append("humain.task_result", "system", full, "public");
    return full;
  }

  recordArtifact(a: Omit<HumainArtifact, "sessionId">): void {
    this.assertActive();
    const full: HumainArtifact = { ...a, sessionId: this.sessionId };
    this.artifacts.push(full);
    this.room.store.append("humain.artifact", "system", full, "public");
  }

  // ---------------- terminal ----------------

  /** Manual stop and revocation always work, from any non-terminal state. */
  stop(reason: "manual-stop" | "revoked", detail: string): void {
    if (this.terminal) return;
    this.stopRecording(`${reason}: ${detail}`);
    this.finishTerminal(reason, detail);
  }

  finish(detail: string): void {
    this.assertActive();
    this.finishTerminal("done", detail);
  }

  private finishTerminal(reason: HumainStopped["reason"], detail: string): void {
    if (this.terminal) return;
    this.recording = false;
    this.terminal = { sessionId: this.sessionId, reason, detail };
    this.phase = "terminal";
    this.room.store.append("humain.stopped", "system", this.terminal, "public");
  }

  private assertActive(): void {
    if (this.terminal) throw new RuleError("humain", `Session ${this.sessionId} is over (${this.terminal.reason}).`);
  }

  // ---------------- views ----------------

  state(): SessionState {
    this.closeInputIfExpired();
    return {
      sessionId: this.sessionId,
      phase: this.phase,
      recording: this.recording,
      inputWindowMin: this.inputWindowMin,
      inputRemainingMs: this.inputDeadline.remainingMs(),
      inputClosed: this.phase !== "listening",
      transcriptChars: this.ideaText().length,
      transcriptChunks: this.transcript.length,
      transcriptSaved: this.saveTranscript,
      plan: this.plan,
      capabilities: this.capabilities,
      estimate: this.estimate,
      approval: this.approval,
      computeRemainingMs: this.computeDeadline?.remainingMs() ?? null,
      spendUsd: Math.round(this.spendUsd * 10000) / 10000,
      decisions: { ...this.decisions },
      blocked: [...this.blocked],
      results: [...this.results],
      artifacts: [...this.artifacts],
      terminal: this.terminal,
    };
  }

  replay() {
    return this.room.store.all().filter((e) => e.type.startsWith("humain.") && (e.payload as any).sessionId === this.sessionId);
  }

  get currentPlan(): HumainPlan | null {
    return this.plan;
  }

  get currentApproval(): HumainApproved | null {
    return this.approval;
  }
}
