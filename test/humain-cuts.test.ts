import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUT_OPS,
  MAX_EDITS,
  PROTECTED_LINE,
  REVISE_SYSTEM_PROMPT,
  applyEdits,
  buildReviseContract,
  buildReviseTasks,
  editTarget,
  feedbackCoverage,
  isCutRevision,
  loadCritiques,
  loadCut,
  loadTake,
  preservedLines,
  renderDiff,
  reuseLine,
  rewriteCount,
  reviseUserPrompt,
  validateEdits,
} from "../src/humain/cuts.ts";
import type { CutDoc, CutEdit, CutRevision } from "../src/humain/cuts.ts";

const { cut: TAKE1 } = loadCut("going-viral");
const FIDS = ["F1", "F2"];
const ed = (op: CutEdit["op"], args: Partial<CutEdit> = {}): CutEdit => ({ op, why: "Fix the framing.", fixes: "F1", ...args });

test("going-viral fixture loads with 48 voice lines", () => {
  assert.equal(TAKE1.take, 1);
  assert.equal(TAKE1.lines.length, 48);
  assert.ok(TAKE1.rough_cut_url.startsWith("https://"));
  assert.throws(() => loadCut("no-such-episode"));
  assert.throws(() => loadCut("../escape"));
  assert.throws(() => loadTake("going-viral", 99));
  assert.match(loadCritiques("going-viral", 1), /too small/);
});

test("validator accepts a good revision and rejects each invariant violation", () => {
  const good: CutEdit[] = [
    ed("set_shot", { shot: "MON_C", zoom: 3.0, x: 640, y: 146 }),
    ed("set_monitor", { span: "s2", from: { mark: "contract", off: 0 }, to: { mark: "execute", off: 0.6 }, crop: [320, 180, 640, 360] }),
    ed("remove_cue", { before: "v2_016", fixes: "F2" }),
    ed("drop_line", { id: "v2_016", fixes: "F2" }),
  ];
  assert.deepEqual(validateEdits(TAKE1, good, FIDS, []), []);

  const bad: Array<[string, CutEdit[], string[], Array<{ fixes: string; reason: string }>]> = [
    ["unknown op", [{ ...ed("set_shot"), op: "explode" } as unknown as CutEdit], FIDS, []],
    ["unknown span", [ed("set_monitor", { span: "s9", from: { mark: "contract", off: 0 }, to: { mark: "execute", off: 0 } })], FIDS, []],
    ["unknown mark", [ed("set_monitor", { span: "s2", from: { mark: "nope", off: 0 }, to: { mark: "execute", off: 0 } })], FIDS, []],
    ["capture time below 0", [ed("set_monitor", { span: "s2", from: { mark: "page", off: -5 }, to: { mark: "execute", off: 0 } })], FIDS, []],
    ["capture time past marks.end", [ed("set_monitor", { span: "s2", from: { mark: "contract", off: 0 }, to: { mark: "end", off: 99 } })], FIDS, []],
    ["crop aspect too narrow", [ed("set_monitor", { span: "s2", from: { mark: "contract", off: 0 }, to: { mark: "execute", off: 0 }, crop: [0, 0, 300, 300] })], FIDS, []],
    ["crop aspect too wide", [ed("set_monitor", { span: "s2", from: { mark: "contract", off: 0 }, to: { mark: "execute", off: 0 }, crop: [0, 0, 1280, 400] })], FIDS, []],
    ["crop outside frame", [ed("set_monitor", { span: "s2", from: { mark: "contract", off: 0 }, to: { mark: "execute", off: 0 }, crop: [1000, 600, 640, 360] })], FIDS, []],
    ["unknown shot", [ed("set_shot", { shot: "NOPE", zoom: 2, x: 0, y: 0 })], FIDS, []],
    ["zoom too low", [ed("set_shot", { shot: "MON", zoom: 0.5, x: 0, y: 0 })], FIDS, []],
    ["zoom too high", [ed("set_shot", { shot: "MON", zoom: 9, x: 0, y: 0 })], FIDS, []],
    ["set_cue unknown line", [ed("set_cue", { before: "v9_999", shot: "MON" })], FIDS, []],
    ["set_cue unknown shot", [ed("set_cue", { before: "v1_001", shot: "NOPE" })], FIDS, []],
    ["set_cue bad hold_through", [ed("set_cue", { before: "v1_001", shot: "MON", hold_through: "v9_999" })], FIDS, []],
    ["remove_cue unknown line", [ed("remove_cue", { before: "v9_999" })], FIDS, []],
    [`move ${PROTECTED_LINE}`, [ed("move_line", { id: PROTECTED_LINE, after: "v1_001" })], FIDS, []],
    [`drop ${PROTECTED_LINE}`, [ed("drop_line", { id: PROTECTED_LINE })], FIDS, []],
    [`rewrite ${PROTECTED_LINE}`, [ed("rewrite_line", { id: PROTECTED_LINE, text: "new" })], FIDS, []],
    ["move across scenes", [ed("move_line", { id: "v2_010", after: "v1_001" })], FIDS, []],
    ["move after unknown line", [ed("move_line", { id: "v2_010", after: "v9_999" })], FIDS, []],
    ["drop unknown line", [ed("drop_line", { id: "v9_999" })], FIDS, []],
    ["drop a cued line", [ed("drop_line", { id: "v2_016" })], FIDS, []],
    ["rewrite unknown line", [ed("rewrite_line", { id: "v9_999", text: "new" })], FIDS, []],
    ["rewrite empty text", [ed("rewrite_line", { id: "v1_001", text: "  " })], FIDS, []],
    ["end card too many lines", [ed("set_end_card", { lines: ["a", "b", "c", "d", "e", "f", "g"] })], FIDS, []],
    ["end card line too long", [ed("set_end_card", { lines: ["x".repeat(61)] })], FIDS, []],
    ["missing why", [{ op: "remove_cue", before: "v1_001", fixes: "F1", why: "  " }], FIDS, []],
    ["fixes unknown feedback", [ed("remove_cue", { before: "v1_001", fixes: "F9" })], FIDS, []],
    ["declined without reason", [ed("remove_cue", { before: "v1_001" })], FIDS, [{ fixes: "F2", reason: "" }]],
    ["declined unknown feedback", [ed("remove_cue", { before: "v1_001" })], FIDS, [{ fixes: "F9", reason: "no" }]],
  ];
  for (const [name, edits, fids, declined] of bad) {
    const errs = validateEdits(TAKE1, edits, fids, declined);
    assert.ok(errs.length > 0, `${name}: expected rejection, got accept`);
  }
});

test("validator enforces the edit cap and feedback coverage", () => {
  const six = Array.from({ length: 6 }, () => ed("remove_cue", { before: "v1_001" }));
  assert.deepEqual(validateEdits(TAKE1, six, ["F1"], []), []);
  const seven = [...six, ed("remove_cue", { before: "v1_002" })];
  assert.match(validateEdits(TAKE1, seven, ["F1"], []).join(";"), new RegExp(`at most ${MAX_EDITS}`));

  const one = [ed("remove_cue", { before: "v1_001" })];
  assert.match(validateEdits(TAKE1, one, FIDS, []).join(";"), /F2 is neither fixed/);
  assert.deepEqual(validateEdits(TAKE1, one, FIDS, [{ fixes: "F2", reason: "Out of scope for this take." }]), []);
  assert.match(validateEdits(TAKE1, one, FIDS, [{ fixes: "F1", reason: "Also declined." }]).join(";"), /both fixed and declined/);
  assert.deepEqual(feedbackCoverage([{ id: "F1", point: "p" }], one, []), { uncovered: [], double: [] });
});

test("applyEdits is pure, bumps the take, and applies every op", () => {
  const frozen = JSON.stringify(TAKE1);
  const edits: CutEdit[] = [
    ed("set_shot", { shot: "MON_C", zoom: 3.0, x: 640, y: 146 }),
    ed("set_monitor", { span: "s4", from: { mark: "done", off: 0 }, to: { mark: "done", off: 5 }, crop: null }),
    ed("set_cue", { before: "v1_001", shot: "TRIO", lead: 0.4, fixes: "F2" }),
    ed("move_line", { id: "v1_002", after: "v1_003", fixes: "F2" }),
    ed("rewrite_line", { id: "v1_001", text: "I have entered us in a contest!", fixes: "F2" }),
    ed("set_end_card", { lines: ["FUTURE RADIO"], fixes: "F2" }),
  ];
  assert.deepEqual(validateEdits(TAKE1, edits, FIDS, []), []);
  const take2 = applyEdits(TAKE1, edits);
  assert.equal(JSON.stringify(TAKE1), frozen); // input untouched
  assert.equal(take2.take, 2);
  assert.equal(take2.shots.MON_C.zoom, 3.0);
  assert.deepEqual(take2.monitor.find((m) => m.span === "s4")?.from, { mark: "done", off: 0 });
  assert.equal(take2.cues.find((c) => c.before === "v1_001")?.shot, "TRIO");
  assert.deepEqual(
    take2.lines.slice(0, 4).map((l) => l.id),
    ["v1_001", "v1_003", "v1_002", "v1_004"],
  );
  assert.equal(take2.lines[0].text, "I have entered us in a contest!");
  assert.deepEqual(take2.end_card, ["FUTURE RADIO"]);
  assert.throws(() => applyEdits(TAKE1, [{ ...ed("set_shot"), op: "nope" } as unknown as CutEdit]), /unknown cut op/);
});

test("preserved lines, reuse line, and diff read off before/after", () => {
  const revision: CutRevision = {
    feedback: [
      { id: "F1", point: "Monitor too small." },
      { id: "F2", point: "Fix a typo." },
    ],
    edits: [
      ed("set_shot", { shot: "MON_C", zoom: 3.2, x: 640, y: 146 }),
      ed("rewrite_line", { id: "v5_046", text: "And sell it now!", fixes: "F2" }),
    ],
    declined: [],
  };
  const take2 = applyEdits(TAKE1, revision.edits);
  assert.deepEqual(preservedLines(TAKE1, take2), { preserved: 47, total: 48 });
  assert.equal(rewriteCount(revision), 1);
  assert.equal(reuseLine(2, 47, 48, 1), "2 edits · 47/48 lines reused · 1 new recording");
  assert.equal(reuseLine(4, 48, 48, 0), "4 edits · 48/48 lines reused · 0 new recordings");
  const diff = renderDiff(TAKE1, take2, revision);
  assert.match(diff, /Going Viral: take 1 → take 2/);
  assert.match(diff, /2 edits · 47\/48 lines reused · 1 new recording/);
  assert.match(diff, /set_shot MON_C \(fixes F1\)/);
  assert.match(diff, /before: .*2\.7.*after: .*3\.2/s);
  assert.match(diff, /rewrite_line v5_046 \(fixes F2\)/);
  assert.match(diff, /before: "And sell it!"/);
  assert.match(diff, /after: "And sell it now!"/);
  assert.equal(editTarget(revision.edits[0]), "MON_C");
});

test("revise prompt carries the required instructions and every op", () => {
  assert.match(REVISE_SYSTEM_PROMPT, /smallest set of edits that fixes the feedback while preserving everything else/);
  assert.match(REVISE_SYSTEM_PROMPT, /Prefer set_monitor\/set_shot\/set_cue over rewrite_line, because rewriting costs a new voice recording/);
  for (const op of CUT_OPS) assert.ok(REVISE_SYSTEM_PROMPT.includes(op), `prompt names ${op}`);
  const user = reviseUserPrompt("Make the monitor bigger.", TAKE1, "too small");
  assert.match(user, /Make the monitor bigger/);
  assert.match(user, /"feedback":\[{"id":"F1","point":""}\]/);
  assert.match(user, /"declined":\[{"fixes":"","reason":""}\]/);
  assert.ok(isCutRevision({ feedback: [{ id: "F1", point: "p" }], edits: [ed("remove_cue", { before: "v1_001" })], declined: [] }));
  assert.equal(isCutRevision({ feedback: [], edits: [], declined: [{ fixes: "F1" }] }), false);
  assert.equal(isCutRevision({ nope: true }), false);
});

test("revise tasks are one build per edit with cut context", () => {
  const revision: CutRevision = {
    feedback: [{ id: "F1", point: "p" }],
    edits: [ed("set_shot", { shot: "MON", zoom: 2, x: 1, y: 2 }), ed("remove_cue", { before: "v1_001" })],
    declined: [],
  };
  const tasks = buildReviseTasks("H-0099", "going-viral", 1, revision);
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((t) => t.kind === "build" && t.capability === "cut.edit"));
  assert.deepEqual(tasks[0].cut, { episode: "going-viral", take: 1, editIndex: 0, revision });
  assert.deepEqual(tasks[1].cut?.editIndex, 1);

  const plan = { sessionId: "H-0099", idea: "x", hook: "h", planner: "muse-spark-1.3", tasks: tasks.map((t, i) => ({ ...t, taskId: `H-0099-T${i + 1}` })) };
  const contract = buildReviseContract("H-0099", plan, TAKE1, revision, "going-viral", 1);
  const checks = contract.acceptance.map((a) => a.check);
  for (const c of ["cut.edits_valid", "cut.feedback_addressed", "cut.edit_count", "cut.reuse_reported", "cut.voice_booked", "workspace.file", "task.evidence"])
    assert.ok(checks.includes(c), `contract has ${c}`);
  assert.equal(contract.acceptance.filter((a) => a.check === "workspace.file").length, 3);
  assert.match(contract.desired, /take 1 → take 2/);
  assert.deepEqual(contract.satisfied, []);
  const probed = buildReviseContract("H-0099", plan, TAKE1, revision, "going-viral", 1, (t) => ({ pass: t.check === "cut.edit_count", detail: "stub" }));
  assert.equal(probed.satisfied.length, 1);
});
