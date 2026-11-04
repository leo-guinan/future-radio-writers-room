// Cut revision: revise a Future Radio cut (take N -> take N+1) through the same
// voice-first HumAIn OS flow as frames, but targeting a cut file. The validator
// enforces every invariant in demo/cuts/CUT_SCHEMA.md in code, never by prompt.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HumainAcceptanceTest, HumainPlan, HumainPlanTask } from "../core/types.ts";
import { RestrictedWorkspace } from "./executor.ts";

// ---------------------------------------------------------------- types

export interface CutLine {
  id: string;
  speaker: string;
  text: string;
}

export interface CutShot {
  zoom: number;
  x: number;
  y: number;
}

export interface CutCue {
  before: string;
  shot: string;
  lead?: number;
  hold_after?: number;
  hold_through?: string;
}

export interface CutMarkRef {
  mark: string;
  off: number;
}

export interface CutMonitorSpan {
  span: string;
  note?: string;
  from: CutMarkRef;
  to: CutMarkRef;
  crop: null | [number, number, number, number];
}

export interface CutDoc {
  schema: string;
  episode: string;
  title: string;
  take: number;
  rough_cut_url: string;
  runtime_s: number;
  capture: {
    session: string;
    fps: number;
    width: number;
    height: number;
    marks: Record<string, number>;
  };
  lines: CutLine[];
  shots: Record<string, CutShot>;
  cues: CutCue[];
  monitor: CutMonitorSpan[];
  end_card: string[];
}

export const CUT_OPS = ["set_monitor", "set_shot", "set_cue", "remove_cue", "move_line", "drop_line", "rewrite_line", "set_end_card"] as const;
export type CutOp = (typeof CUT_OPS)[number];

/** One validated edit. Args are per-op; Spark sends plain JSON and the validator checks it. */
export interface CutEdit {
  op: CutOp;
  why: string;
  fixes: string;
  span?: string;
  from?: CutMarkRef;
  to?: CutMarkRef;
  crop?: null | [number, number, number, number];
  shot?: string;
  zoom?: number;
  x?: number;
  y?: number;
  before?: string;
  lead?: number;
  hold_after?: number;
  hold_through?: string;
  id?: string;
  after?: string | null;
  text?: string;
  lines?: string[];
}

export interface CutFeedback {
  id: string;
  point: string;
}

export interface CutDeclined {
  fixes: string;
  reason: string;
}

export interface CutRevision {
  feedback: CutFeedback[];
  edits: CutEdit[];
  declined: CutDeclined[];
}

/** Revision context carried on each cut.edit plan task (auditable in the log). */
export interface TaskCutContext {
  episode: string;
  take: number;
  editIndex: number;
  revision: CutRevision;
}

export const PROTECTED_LINE = "v1_006"; // Leonardo's command: the live mic input of the recorded run
export const MAX_EDITS = 6;
export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 3.5;
export const CROP_ASPECT_MIN = 1.5;
export const CROP_ASPECT_MAX = 2.0;
export const END_CARD_MAX_LINES = 6;
export const END_CARD_MAX_CHARS = 60;
/** Estimated local effort per rewrite_line (a new voice recording must be booked). */
export const VOICE_HOURS_PER_RECORDING = 0.1;

/** Where cut fixtures live. Tests point CUTS_DIR at a temp copy. */
export const CUTS_ROOT = () => process.env.CUTS_DIR ?? join(process.cwd(), "demo", "cuts");

// ---------------------------------------------------------------- loading

function checkEpisode(episode: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(episode)) throw new Error(`Bad episode name: ${episode}`);
}

/** Load take N of an episode. Throws when the episode or take does not exist. */
export function loadTake(episode: string, take: number): { cut: CutDoc; dir: string } {
  checkEpisode(episode);
  const dir = join(CUTS_ROOT(), episode);
  const file = join(dir, `take${take}.cut.json`);
  if (!existsSync(file)) throw new Error(`No take ${take} for episode ${episode} (${file}).`);
  const cut = JSON.parse(readFileSync(file, "utf8")) as CutDoc;
  if (!Array.isArray(cut.lines) || typeof cut.shots !== "object" || !Array.isArray(cut.monitor) || typeof cut.capture?.marks !== "object")
    throw new Error(`take${take}.cut.json is not a cut (missing lines/shots/monitor/marks).`);
  return { cut, dir };
}

/** Load the latest take of an episode. */
export function loadCut(episode: string): { cut: CutDoc; take: number; dir: string } {
  checkEpisode(episode);
  const dir = join(CUTS_ROOT(), episode);
  if (!existsSync(dir)) throw new Error(`No such episode: ${episode}.`);
  const takes = readdirSync(dir)
    .map((f) => f.match(/^take(\d+)\.cut\.json$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => Number(m[1]));
  if (!takes.length) throw new Error(`Episode ${episode} has no takes.`);
  const take = Math.max(...takes);
  return { ...loadTake(episode, take), take };
}

/** Written critiques for a take (takeN.feedback.md, falling back to take1's). */
export function loadCritiques(episode: string, take: number): string {
  checkEpisode(episode);
  const dir = join(CUTS_ROOT(), episode);
  for (const n of [take, 1]) {
    const f = join(dir, `take${n}.feedback.md`);
    if (existsSync(f)) return readFileSync(f, "utf8");
  }
  return "";
}

// ---------------------------------------------------------------- validation

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const sceneOf = (id: string): string => id.split("_")[0];

/** Feedback points neither fixed by an edit nor declined with a reason. */
export function feedbackCoverage(feedback: CutFeedback[], edits: CutEdit[], declined: CutDeclined[]): { uncovered: string[]; double: string[] } {
  const fixed = new Set(edits.map((e) => e.fixes));
  const refused = new Set(declined.map((d) => d.fixes));
  return {
    uncovered: feedback.map((f) => f.id).filter((id) => !fixed.has(id) && !refused.has(id)),
    double: feedback.map((f) => f.id).filter((id) => fixed.has(id) && refused.has(id)),
  };
}

/**
 * Validate a revision against a cut. Covers every invariant in CUT_SCHEMA.md:
 * op allowlist; referenced ids, shots, spans and marks exist; capture time in
 * [0, marks.end]; crop aspect in [1.5, 2.0]; zoom in [0.8, 3.5]; v1_006
 * untouchable; at most 6 edits; every feedback point fixed or declined.
 * Edits are checked sequentially against evolving state, so remove_cue then
 * drop_line on the same line is legal but a dangling cue is impossible.
 */
export function validateEdits(cut: CutDoc, edits: CutEdit[], feedbackIds: string[], declined: CutDeclined[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(edits)) return ["edits must be an array"];
  if (edits.length > MAX_EDITS) errors.push(`at most ${MAX_EDITS} edits; got ${edits.length}`);
  const end = cut.capture.marks.end;
  const lines = new Map(cut.lines.map((l) => [l.id, l]));
  let cues = cut.cues.map((c) => ({ ...c }));
  const cueTargets = () => new Set([...cues.map((c) => c.before), ...cues.map((c) => c.hold_through).filter((h): h is string => Boolean(h) && h !== "END")]);

  edits.forEach((e, i) => {
    const at = `edit ${i + 1}`;
    if (!e || typeof e !== "object" || !(CUT_OPS as readonly string[]).includes((e as CutEdit).op)) {
      errors.push(`${at}: unknown op ${JSON.stringify((e as CutEdit)?.op)} (allowed: ${CUT_OPS.join(", ")})`);
      return;
    }
    if (typeof e.why !== "string" || !e.why.trim()) errors.push(`${at}: why is required (one sentence)`);
    if (!feedbackIds.includes(e.fixes)) errors.push(`${at}: fixes ${JSON.stringify(e.fixes)} names no feedback point (${feedbackIds.join(", ") || "none"})`);
    switch (e.op) {
      case "set_monitor": {
        const span = cut.monitor.find((m) => m.span === e.span);
        if (!span) {
          errors.push(`${at}: unknown span ${JSON.stringify(e.span)}`);
          break;
        }
        for (const side of ["from", "to"] as const) {
          const ref = e[side];
          if (!ref || typeof ref.mark !== "string" || !(ref.mark in cut.capture.marks)) {
            errors.push(`${at}: ${side}.mark ${JSON.stringify(ref?.mark)} names no capture mark`);
            continue;
          }
          if (!isNum(ref.off)) {
            errors.push(`${at}: ${side}.off must be a number`);
            continue;
          }
          const t = cut.capture.marks[ref.mark] + ref.off;
          if (!(t >= 0 && t <= end)) errors.push(`${at}: ${side} capture time ${t.toFixed(2)}s is outside [0, ${end}]`);
        }
        if (e.crop !== undefined && e.crop !== null) {
          const c = e.crop;
          const okShape = Array.isArray(c) && c.length === 4 && c.every(isNum);
          const [x, y, w, h] = okShape ? c : [NaN, NaN, NaN, NaN];
          if (!okShape || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > cut.capture.width || y + h > cut.capture.height)
            errors.push(`${at}: crop must be [x, y, w, h] inside ${cut.capture.width}x${cut.capture.height}`);
          else {
            const aspect = w / h;
            if (!(aspect >= CROP_ASPECT_MIN && aspect <= CROP_ASPECT_MAX))
              errors.push(`${at}: crop aspect ${aspect.toFixed(2)} is outside [${CROP_ASPECT_MIN}, ${CROP_ASPECT_MAX}]`);
          }
        }
        break;
      }
      case "set_shot": {
        if (!(e.shot && e.shot in cut.shots)) {
          errors.push(`${at}: unknown shot ${JSON.stringify(e.shot)}`);
          break;
        }
        if (!isNum(e.zoom) || e.zoom < ZOOM_MIN || e.zoom > ZOOM_MAX) errors.push(`${at}: zoom must be in [${ZOOM_MIN}, ${ZOOM_MAX}]`);
        if (!isNum(e.x) || !isNum(e.y)) errors.push(`${at}: x and y must be numbers`);
        break;
      }
      case "set_cue": {
        if (!e.before || !lines.has(e.before)) errors.push(`${at}: before ${JSON.stringify(e.before)} names no line`);
        if (!(e.shot && e.shot in cut.shots)) errors.push(`${at}: unknown shot ${JSON.stringify(e.shot)}`);
        if (e.lead !== undefined && !isNum(e.lead)) errors.push(`${at}: lead must be a number`);
        if (e.hold_after !== undefined && !isNum(e.hold_after)) errors.push(`${at}: hold_after must be a number`);
        if (e.hold_through !== undefined && e.hold_through !== "END" && !lines.has(e.hold_through))
          errors.push(`${at}: hold_through ${JSON.stringify(e.hold_through)} names no line (or "END")`);
        break;
      }
      case "remove_cue": {
        if (!e.before || !lines.has(e.before)) errors.push(`${at}: before ${JSON.stringify(e.before)} names no line`);
        else cues = cues.filter((c) => c.before !== e.before);
        break;
      }
      case "move_line": {
        if (!e.id || !lines.has(e.id)) {
          errors.push(`${at}: id ${JSON.stringify(e.id)} names no line`);
          break;
        }
        if (e.id === PROTECTED_LINE) {
          errors.push(`${at}: ${PROTECTED_LINE} cannot be moved`);
          break;
        }
        if (e.after !== null && (typeof e.after !== "string" || !lines.has(e.after))) {
          errors.push(`${at}: after ${JSON.stringify(e.after)} names no line (or null for first)`);
          break;
        }
        if (e.after !== null && (e.after === e.id || sceneOf(e.after) !== sceneOf(e.id))) {
          errors.push(`${at}: the line must stay in its scene (${sceneOf(e.id)})`);
          break;
        }
        break;
      }
      case "drop_line": {
        if (!e.id || !lines.has(e.id)) {
          errors.push(`${at}: id ${JSON.stringify(e.id)} names no line`);
          break;
        }
        if (e.id === PROTECTED_LINE) {
          errors.push(`${at}: ${PROTECTED_LINE} cannot be dropped`);
          break;
        }
        if (cueTargets().has(e.id)) {
          errors.push(`${at}: ${e.id} still has a cue; remove_cue first so the take keeps no dangling references`);
          break;
        }
        lines.delete(e.id);
        break;
      }
      case "rewrite_line": {
        if (!e.id || !lines.has(e.id)) errors.push(`${at}: id ${JSON.stringify(e.id)} names no line`);
        else if (e.id === PROTECTED_LINE) errors.push(`${at}: ${PROTECTED_LINE} cannot be rewritten`);
        if (typeof e.text !== "string" || !e.text.trim()) errors.push(`${at}: text is required`);
        break;
      }
      case "set_end_card": {
        if (!Array.isArray(e.lines)) {
          errors.push(`${at}: lines[] is required`);
          break;
        }
        if (e.lines.length > END_CARD_MAX_LINES) errors.push(`${at}: up to ${END_CARD_MAX_LINES} end-card lines; got ${e.lines.length}`);
        e.lines.forEach((l, j) => {
          if (typeof l !== "string" || l.length > END_CARD_MAX_CHARS) errors.push(`${at}: end-card line ${j + 1} must be a string up to ${END_CARD_MAX_CHARS} chars`);
        });
        break;
      }
    }
  });

  if (!Array.isArray(declined)) {
    errors.push("declined must be an array");
    return errors;
  }
  declined.forEach((d, i) => {
    if (!feedbackIds.includes(d?.fixes)) errors.push(`declined ${i + 1}: fixes ${JSON.stringify(d?.fixes)} names no feedback point`);
    if (typeof d?.reason !== "string" || !d.reason.trim()) errors.push(`declined ${i + 1}: a reason is required`);
  });
  const { uncovered, double } = feedbackCoverage(
    feedbackIds.map((id) => ({ id, point: "" })),
    edits.filter((e) => e && typeof e === "object"),
    declined.filter((d) => d && typeof d === "object"),
  );
  for (const id of uncovered) errors.push(`${id} is neither fixed by an edit nor declined with a reason`);
  for (const id of double) errors.push(`${id} is both fixed and declined; pick one`);
  return errors;
}

// ---------------------------------------------------------------- apply (pure)

/** Apply one edit to a cut object in place. Throws on unknown ops (fail closed). */
function applyOne(cut: CutDoc, e: CutEdit): void {
  switch (e.op) {
    case "set_monitor": {
      const span = cut.monitor.find((m) => m.span === e.span)!;
      span.from = { ...e.from! };
      span.to = { ...e.to! };
      if (e.crop !== undefined) span.crop = e.crop === null ? null : [...e.crop] as [number, number, number, number];
      break;
    }
    case "set_shot":
      cut.shots[e.shot!] = { zoom: e.zoom!, x: e.x!, y: e.y! };
      break;
    case "set_cue": {
      const prev: CutCue = cut.cues.find((c) => c.before === e.before) ?? { before: e.before!, shot: e.shot! };
      cut.cues = cut.cues.filter((c) => c.before !== e.before);
      const next: CutCue = { before: e.before!, shot: e.shot! };
      // Omitted timing carries over from the replaced cue; nothing is invented.
      if ((e.lead ?? prev.lead) !== undefined) next.lead = (e.lead ?? prev.lead)!;
      if ((e.hold_after ?? prev.hold_after) !== undefined) next.hold_after = (e.hold_after ?? prev.hold_after)!;
      if ((e.hold_through ?? prev.hold_through) !== undefined) next.hold_through = (e.hold_through ?? prev.hold_through)!;
      cut.cues.push(next);
      break;
    }
    case "remove_cue":
      cut.cues = cut.cues.filter((c) => c.before !== e.before);
      break;
    case "move_line": {
      const at = cut.lines.findIndex((l) => l.id === e.id);
      const [line] = cut.lines.splice(at, 1);
      if (e.after === null) cut.lines.unshift(line);
      else cut.lines.splice(cut.lines.findIndex((l) => l.id === e.after) + 1, 0, line);
      break;
    }
    case "drop_line":
      cut.lines = cut.lines.filter((l) => l.id !== e.id);
      break;
    case "rewrite_line":
      cut.lines.find((l) => l.id === e.id)!.text = e.text!;
      break;
    case "set_end_card":
      cut.end_card = [...e.lines!];
      break;
    default:
      throw new Error(`Refusing unknown cut op: ${JSON.stringify((e as CutEdit)?.op)}`);
  }
}

const clone = (cut: CutDoc): CutDoc => JSON.parse(JSON.stringify(cut)) as CutDoc;

/**
 * Apply validated edits, purely: the input cut is never mutated. Returns the
 * next take (take + 1). Callers validate with validateEdits first; unknown ops
 * still throw here so an unvalidated call fails closed.
 */
export function applyEdits(cut: CutDoc, edits: CutEdit[]): CutDoc {
  const next = clone(cut);
  for (const e of edits) applyOne(next, e);
  next.take = cut.take + 1;
  return next;
}

/** Lines whose text is unchanged, measured against the source take. */
export function preservedLines(before: CutDoc, after: CutDoc): { preserved: number; total: number } {
  const afterById = new Map(after.lines.map((l) => [l.id, l.text]));
  const preserved = before.lines.filter((l) => afterById.get(l.id) === l.text).length;
  return { preserved, total: before.lines.length };
}

export const rewriteCount = (revision: CutRevision): number => revision.edits.filter((e) => e.op === "rewrite_line").length;

export function reuseLine(editCount: number, preserved: number, total: number, rewrites: number): string {
  return `${editCount} edits · ${preserved}/${total} lines reused · ${rewrites} new recording${rewrites === 1 ? "" : "s"}`;
}

/** Short human target for an edit (titles, rows, diff headers). */
export function editTarget(e: CutEdit): string {
  switch (e.op) {
    case "set_monitor":
      return String(e.span);
    case "set_shot":
      return String(e.shot);
    case "set_cue":
    case "remove_cue":
      return String(e.before);
    case "move_line":
    case "drop_line":
    case "rewrite_line":
      return String(e.id);
    case "set_end_card":
      return "end_card";
  }
}

// ---------------------------------------------------------------- diff

function fmt(v: unknown): string {
  return typeof v === "string" ? `"${v}"` : JSON.stringify(v);
}

function cueText(cut: CutDoc, before: string): string {
  const c = cut.cues.find((x) => x.before === before);
  return c ? fmt(c) : "(automatic coverage)";
}

/** Before/after values for one edit, read off the take as the edits apply in order. */
function editBeforeAfter(cur: CutDoc, e: CutEdit): { before: string; after: string } {
  switch (e.op) {
    case "set_monitor": {
      const s = cur.monitor.find((m) => m.span === e.span)!;
      const before = `from ${fmt(s.from)} to ${fmt(s.to)} crop ${fmt(s.crop)}`;
      applyOne(cur, e);
      const a = cur.monitor.find((m) => m.span === e.span)!;
      return { before, after: `from ${fmt(a.from)} to ${fmt(a.to)} crop ${fmt(a.crop)}` };
    }
    case "set_shot": {
      const before = fmt(cur.shots[e.shot!]);
      applyOne(cur, e);
      return { before, after: fmt(cur.shots[e.shot!]) };
    }
    case "set_cue": {
      const before = cueText(cur, e.before!);
      applyOne(cur, e);
      return { before, after: cueText(cur, e.before!) };
    }
    case "remove_cue": {
      const before = cueText(cur, e.before!);
      applyOne(cur, e);
      return { before, after: "(automatic coverage)" };
    }
    case "move_line": {
      const ids = cur.lines.map((l) => l.id).join(" ");
      applyOne(cur, e);
      return { before: `order: ${ids}`, after: `order: ${cur.lines.map((l) => l.id).join(" ")}` };
    }
    case "drop_line": {
      const line = cur.lines.find((l) => l.id === e.id)!;
      applyOne(cur, e);
      return { before: `${e.id} ${line.speaker}: "${line.text}"`, after: "(removed)" };
    }
    case "rewrite_line": {
      const before = cur.lines.find((l) => l.id === e.id)!.text;
      applyOne(cur, e);
      return { before: `"${before}"`, after: `"${e.text}"` };
    }
    case "set_end_card": {
      const before = cur.end_card.map((l) => `"${l}"`).join(" / ");
      applyOne(cur, e);
      return { before: before || "(empty)", after: cur.end_card.map((l) => `"${l}"`).join(" / ") };
    }
  }
}

/** Human-readable diff: each edit with the feedback it fixes and before/after values. */
export function renderDiff(before: CutDoc, after: CutDoc, revision: CutRevision): string {
  const point = (id: string) => revision.feedback.find((f) => f.id === id)?.point ?? "(point not recorded)";
  const { preserved, total } = preservedLines(before, after);
  const rw = rewriteCount(revision);
  const out: string[] = [
    `# ${before.title}: take ${before.take} → take ${after.take}`,
    "",
    reuseLine(revision.edits.length, preserved, total, rw),
    "",
  ];
  const cur = clone(before);
  revision.edits.forEach((e, i) => {
    const { before: b, after: a } = editBeforeAfter(cur, e);
    out.push(`## ${i + 1}. ${e.op} ${editTarget(e)} (fixes ${e.fixes})`, "", `Feedback: ${point(e.fixes)}`, "", `Why: ${e.why}`, "", `- before: ${b}`, `- after: ${a}`, "");
  });
  if (revision.declined.length) {
    out.push("## Declined", "");
    for (const d of revision.declined) out.push(`- ${d.fixes} (${point(d.fixes)}): ${d.reason}`);
    out.push("");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- Spark revision prompt

export const REVISE_SYSTEM_PROMPT = [
  "You revise a Future Radio cut: a JSON take of an episode.",
  "The goal is the smallest set of edits that fixes the feedback while preserving everything else.",
  "Use only these ops: set_monitor (span, from {mark, off}, to {mark, off}, crop [x,y,w,h] or null),",
  "set_shot (shot, zoom in [0.8, 3.5], x, y), set_cue (before line id, shot, lead?, hold_after?, hold_through line id or END),",
  "remove_cue (before), move_line (id, after line id or null for first, same scene only), drop_line (id),",
  "rewrite_line (id, text), set_end_card (lines[], up to 6 lines of up to 60 chars).",
  "Every edit needs why (one sentence) and fixes (a feedback id).",
  "Prefer set_monitor/set_shot/set_cue over rewrite_line, because rewriting costs a new voice recording.",
  `Line ${PROTECTED_LINE} cannot be moved, dropped or rewritten. A dropped line must have no cue (remove_cue first).`,
  "At most 6 edits. Every feedback point must be fixed by an edit or declined with a reason, never both.",
  "Capture time (mark seconds + off) must stay within [0, marks.end]. Crop aspect w/h must be between 1.5 and 2.0.",
  "Reply with JSON only.",
].join(" ");

export function reviseUserPrompt(transcript: string, cut: CutDoc, critiques: string): string {
  return [
    `Spoken feedback: ${transcript}`,
    "",
    "Written critiques:",
    critiques.trim() || "(none)",
    "",
    "Cut JSON to revise:",
    JSON.stringify(cut),
    "",
    'Reply with JSON only: {"feedback":[{"id":"F1","point":""}],"edits":[{"op":"","why":"","fixes":"F1", ...op args}],"declined":[{"fixes":"","reason":""}]}.',
    "Feedback ids are F1, F2, ... in order. Copy the op args exactly as documented; the system prompt lists every op and its limits.",
  ].join("\n");
}

/** Shape check for Spark's revise reply (deep validation is validateEdits' job). */
export function isCutRevision(p: unknown): p is CutRevision {
  const d = p as CutRevision;
  return (
    Boolean(d) &&
    Array.isArray(d.feedback) &&
    Array.isArray(d.edits) &&
    Array.isArray(d.declined) &&
    d.feedback.every((f) => typeof f?.id === "string" && typeof f?.point === "string") &&
    d.edits.every((e) => typeof e?.op === "string" && typeof e?.why === "string" && typeof e?.fixes === "string") &&
    d.declined.every((x) => typeof x?.fixes === "string" && typeof x?.reason === "string")
  );
}

// ---------------------------------------------------------------- plan + contract

/** One task per edit: kind build, capability cut.edit, revision on every task. */
export function buildReviseTasks(sessionId: string, episode: string, take: number, revision: CutRevision): Array<Omit<HumainPlanTask, "taskId">> {
  return revision.edits.map((edit, i) => ({
    title: `Edit ${i + 1}/${revision.edits.length}: ${edit.op} ${editTarget(edit)}`,
    kind: "build" as const,
    capability: "cut.edit",
    detail: `${edit.op} ${editTarget(edit)} — ${edit.why} (fixes ${edit.fixes})`,
    cut: { episode, take, editIndex: i, revision },
    estApiUsd: 0,
    estHours: 0.05,
    estSeconds: 5,
  }));
}

export type AcceptanceProbe = (t: HumainAcceptanceTest) => { pass: boolean; detail: string };

/** Acceptance tests for a revision: validation, coverage, count, reuse, voice cost, files. */
export function buildReviseContract(
  sessionId: string,
  plan: HumainPlan,
  cut: CutDoc,
  revision: CutRevision,
  episode: string,
  take: number,
  probe?: AcceptanceProbe,
): Omit<import("../core/types.ts").HumainContract, "sessionId"> {
  const expected = `${episode}:take${take}`;
  const nextTake = take + 1;
  const first = plan.tasks[0]?.taskId ?? `${sessionId}-T1`;
  const rw = rewriteCount(revision);
  let n = 0;
  const aid = () => `${sessionId}-A${++n}`;
  const acceptance: HumainAcceptanceTest[] = [
    { id: aid(), description: `Revision edits validate against take ${take}`, check: "cut.edits_valid", target: first, expected },
    { id: aid(), description: `Every feedback point is fixed or declined`, check: "cut.feedback_addressed", target: first, expected },
    { id: aid(), description: `Edit count stays within ${MAX_EDITS}`, check: "cut.edit_count", target: first, expected: String(MAX_EDITS) },
    { id: aid(), description: `Reuse is reported with before/after diff`, check: "cut.reuse_reported", target: first, expected },
    { id: aid(), description: `Voice cost books ${rw} new recording${rw === 1 ? "" : "s"}`, check: "cut.voice_booked", target: first, expected: String(rw) },
    { id: aid(), description: `take${nextTake}.cut.json exists`, check: "workspace.file", target: first, expected: `take${nextTake}.cut.json` },
    { id: aid(), description: `edits.json exists`, check: "workspace.file", target: first, expected: "edits.json" },
    { id: aid(), description: `diff.md exists`, check: "workspace.file", target: first, expected: "diff.md" },
  ];
  for (const t of plan.tasks)
    acceptance.push({ id: aid(), description: `${t.taskId} completes with evidence`, check: "task.evidence", target: t.taskId, expected: "success+evidence" });

  const satisfied: string[] = [];
  if (probe) for (const a of acceptance) {
    const o = probe(a);
    if (o.pass) satisfied.push(`${a.id}: ${a.description} (${o.detail})`);
  }
  return {
    desired: `Revise ${cut.title} take ${take} → take ${nextTake}: address ${revision.feedback.length} feedback point(s) with ${revision.edits.length} edit(s), preserving everything else.`,
    observed: [
      `${episode} take is ${take} ("${cut.title}", evidence: ${episode}/take${take}.cut.json)`,
      `take ${take} holds ${cut.lines.length} voice lines, ${Object.keys(cut.shots).length} shots, ${cut.cues.length} cues, ${cut.monitor.length} monitor spans (evidence: cut JSON scan)`,
      `capture ends at marks.end=${cut.capture.marks.end}s on a ${cut.capture.width}x${cut.capture.height} recording (evidence: cut JSON scan)`,
      `rough cut: ${cut.rough_cut_url} (evidence: cut JSON)`,
    ],
    satisfied,
    modifications: plan.tasks.map((t) => `${t.taskId} [${t.kind}/${t.capability}] ${t.title}`),
    missing: [],
    acceptance,
    limits: { spendCeilingUsd: null, computeDeadlineSecs: null }, // filled at approval
  };
}

// ---------------------------------------------------------------- publish

/** Copy the three revision files from the workspace to the episode dir. Null unless this plan revises a cut. */
export function finalizeRevision(sessionId: string, plan: HumainPlan): { episode: string; take: number; files: string[] } | null {
  const ctx = plan.tasks.find((t) => t.capability === "cut.edit" && t.cut)?.cut;
  if (!ctx) return null;
  const ws = RestrictedWorkspace.open(sessionId);
  const nextTake = ctx.take + 1;
  const names = [`take${nextTake}.cut.json`, "edits.json", "diff.md"];
  const dir = join(CUTS_ROOT(), ctx.episode);
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, name), ws.readFile(name));
  return { episode: ctx.episode, take: nextTake, files: names.map((n) => `${ctx.episode}/${n}`) };
}
