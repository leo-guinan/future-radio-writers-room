import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "humain-data-"));
import assert from "node:assert/strict";
import { EventStore } from "../src/core/events.ts";
import { Room } from "../src/core/room.ts";
import { SessionController } from "../src/humain/session.ts";
import { MetaVoiceTranscriber, OpenRouterSparkPlanner, SparkPlanner, makePlanner, makeTranscriber } from "../src/humain/adapters.ts";
import { Watchdog } from "../src/humain/watchdog.ts";
import { MAX_REPAIRS, executePlan } from "../src/humain/reconcile.ts";
import { allocateFrameIds, listFrames, nextFrameId, publishFrame, readFrame, serveFrame } from "../src/humain/frames.ts";
import { loadWorks, renderComparison } from "../src/humain/frame-maker.ts";
import { runAcceptance } from "../src/humain/observe.ts";

const fresh = () => new Room(new EventStore(null));

function frameSession(room: Room, frameSpec: { hook: string; workA: string; workB: string }, frameId = "F-0001"): SessionController {
  const s = SessionController.open(room, "leo", 2, false);
  s.ingestTranscript("an idea", true, "test");
  s.closeInput("test");
  s.recordPlan({
    idea: "an idea", hook: frameSpec.hook, planner: "test",
    tasks: [{ taskId: `${s.sessionId}-T1`, title: "publish frame", kind: "build", capability: "frame.build", detail: "d", frame: frameSpec, estApiUsd: 0, estHours: 0.1, estSeconds: 5 }],
  });
  s.recordCapabilities({ reuse: [], build: [] });
  s.recordEstimate({ apiUsd: 0, localHours: 0.1, executionSeconds: 5, forecastId: "F-001" });
  s.recordContract(
    {
      desired: "an idea", observed: [], satisfied: [], modifications: [`${s.sessionId}-T1 publish frame`], missing: [],
      acceptance: [
        { id: `${s.sessionId}-A1`, description: "exists", check: "frame.exists", target: frameId, expected: frameId },
        { id: `${s.sessionId}-A2`, description: "serves", check: "frame.serves", target: frameId, expected: "200" },
      ],
      limits: { spendCeilingUsd: null, computeDeadlineSecs: null },
    },
    [{ taskId: `${s.sessionId}-T1`, frameId }],
  );
  s.approve(5, 300);
  return s;
}

test("frames persist with independent hooks and visit counts", () => {
  const works = loadWorks();
  const a = publishFrame(nextFrameId(), "H-0001", "First hook", works[0].work_id, works[1].work_id, renderComparison(works[0], works[1], "First hook"));
  const b = publishFrame(nextFrameId(), "H-0001", "Second hook", works[1].work_id, works[0].work_id, renderComparison(works[1], works[0], "Second hook"));
  assert.notEqual(a.frameId, b.frameId);
  serveFrame(a.frameId, { visitor: "alice" });
  serveFrame(a.frameId, { visitor: "alice" });
  serveFrame(b.frameId, { visitor: "bob" });
  assert.deepEqual(readFrame(a.frameId).counts, { human: 2, unique: 1, verification: 0 });
  assert.deepEqual(readFrame(b.frameId).counts, { human: 1, unique: 1, verification: 0 });
  assert.equal(readFrame(a.frameId).meta.hook, "First hook");
  assert.ok(listFrames().some((f) => f.frameId === a.frameId && f.counts.human === 2));
  assert.throws(() => readFrame("../evil"), /Bad frame id/);
  assert.throws(() => readFrame("F-9999"), /No frame/);
});

test("frame id allocation is atomic: reservations never collide", () => {
  const a = allocateFrameIds(2);
  const b = allocateFrameIds(2);
  assert.equal(new Set([...a, ...b]).size, 4);
  assert.ok(a[0] < a[1] && b[0] < b[1]);
  // Reservations are invisible until published.
  assert.ok(!listFrames().some((f) => a.includes(f.frameId)));
});

test("serves acceptance check verifies without inflating visits", () => {
  const works = loadWorks();
  const id = nextFrameId();
  publishFrame(id, "H-0001", "hook", works[0].work_id, works[1].work_id, renderComparison(works[0], works[1], "hook"));
  const before = readFrame(id).counts;
  const o = runAcceptance({ id: "A1", description: "serves", check: "frame.serves", target: id, expected: "200" }, "H-0001", []);
  assert.equal(o.pass, true);
  assert.deepEqual(readFrame(id).counts, before, "verification counts no visit");
});

test("watchdog halts runs without acceptance progress, not on elapsed time", () => {
  const w = new Watchdog(3);
  assert.equal(w.noteAction(0), true); // baseline
  assert.equal(w.noteAction(0), true); // 1 without progress
  assert.equal(w.noteAction(0), true); // 2 without progress
  assert.equal(w.noteAction(0), false); // 3 without progress: halt
  const w2 = new Watchdog(2);
  assert.equal(w2.noteAction(0), true);
  assert.equal(w2.noteAction(1), true); // progress resets patience
  assert.equal(w2.noteAction(1), true);
  assert.equal(w2.noteAction(1), false);
});

test("reconcile publishes the frame and finishes only on acceptance", async () => {
  const room = fresh();
  const works = loadWorks();
  const fid = nextFrameId();
  const s = frameSession(room, { hook: "Reconciled hook", workA: works[0].work_id, workB: works[1].work_id }, fid);
  await executePlan(room, s, "leo");
  const st = s.state();
  assert.equal(st.terminal?.reason, "done");
  assert.match(st.terminal?.detail ?? "", /2\/2 acceptance tests pass/);
  assert.equal(st.frames.length, 1);
  assert.equal(st.frames[0].frameId, fid);
  assert.ok(readFrame(fid).html.includes("Reconciled hook"));
});

test("failed acceptance triggers bounded repair, then failed result and checkpoint", async () => {
  const room = fresh();
  const fid = nextFrameId();
  // Unknown work id: every build attempt throws, so repairs exhaust.
  const s = frameSession(room, { hook: "Broken hook", workA: "no-such-work", workB: "no-such-work-2" }, fid);
  await executePlan(room, s, "leo");
  const st = s.state();
  assert.equal(st.repairs.length, MAX_REPAIRS);
  assert.ok(st.repairs.every((r) => r.outcome === "still-failing"));
  assert.equal(st.results.at(-1)?.status, "failed");
  assert.equal(st.terminal?.reason, "stalled");
  assert.notEqual(st.terminal?.reason, "done", "duration without progress is not completion");
  assert.ok(st.lastCheckpoint, "checkpoint preserved");
  assert.ok(st.lastCheckpoint!.remaining.length > 0, "remaining requirements preserved");
  assert.ok(room.store.all().some((e) => e.type === "humain.repair"));
  assert.ok(room.store.all().some((e) => e.type === "humain.checkpoint"));
});

test("spark planner calls the documented Meta endpoint and reports usage", async () => {
  let seen: { url: string; init: any } | null = null;
  const fetchImpl = (async (url: string, init: any) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ hook: "h", tasks: [] }) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }) };
  }) as unknown as typeof fetch;
  const p = new SparkPlanner("test-key", "https://api.meta.ai/v1/chat/completions", fetchImpl);
  const r = await p.plan("an idea", { works: [{ work_id: "w", title: "W", kind: "episode" }] });
  assert.equal(seen!.url, "https://api.meta.ai/v1/chat/completions");
  const sent = JSON.parse(seen!.init.body);
  assert.equal(sent.model, "muse-spark-1.3");
  assert.equal(seen!.init.headers.authorization, "Bearer test-key");
  assert.deepEqual(r.usage, { input: 100, output: 50 });
  assert.equal(r.costUsd, null, "unreported cost stays unknown, never zero-as-fact");
  assert.equal(r.offline, false);
});

test("openrouter spark planner targets meta/muse-spark-1.3 with observed cost", async () => {
  const fetchImpl = (async () => ({
    ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } }),
  })) as unknown as typeof fetch;
  const p = new OpenRouterSparkPlanner("or-key", fetchImpl);
  const r = await p.plan("an idea", { works: [] });
  assert.equal(r.costUsd, 0.0001);
  assert.ok(r.draft.tasks.length > 0, "unparseable model output falls back to offline draft");
});

test("live mode fails visibly without Meta APIs, never silently offline", () => {
  const savedLive = process.env.HUMAIN_LIVE;
  const savedKey = process.env.MODEL_API_KEY;
  const savedAlias = process.env.META_MODEL_API_KEY;
  delete process.env.MODEL_API_KEY;
  delete process.env.META_MODEL_API_KEY;
  process.env.HUMAIN_LIVE = "1";
  try {
    assert.throws(() => makePlanner(), /LIVE MODE/);
    assert.throws(() => makeTranscriber(), /LIVE MODE/);
  } finally {
    if (savedLive === undefined) delete process.env.HUMAIN_LIVE;
    else process.env.HUMAIN_LIVE = savedLive;
    if (savedKey !== undefined) process.env.MODEL_API_KEY = savedKey;
    if (savedAlias !== undefined) process.env.META_MODEL_API_KEY = savedAlias;
  }
});

test("voice transcriber posts multipart audio and parses text", async () => {
  let seen: { url: string; init: any } | null = null;
  const fetchImpl = (async (url: string, init: any) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ transcript: "hello radio", audioDurationMs: 1200, sessionId: "s1" }) };
  }) as unknown as typeof fetch;
  const t = new MetaVoiceTranscriber("test-key", "https://api.meta.ai/v1/asr/transcribe", fetchImpl);
  const r = await t.transcribe(Buffer.from("RIFFfake-wav"), "audio/wav");
  assert.equal(seen!.url, "https://api.meta.ai/v1/asr/transcribe");
  assert.equal(seen!.init.headers.authorization, "Bearer test-key");
  assert.ok(seen!.init.body instanceof FormData);
  assert.deepEqual(r.chunks, [{ text: "hello radio", final: true }]);
  assert.equal(r.costUsd, null, "the cookbook response carries no cost field");
});
