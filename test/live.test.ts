// ACCEPTANCE: a live run plays the library to the end; each thread update interrupts it with
// freeze -> announce -> react (<= 30 s) -> return, and the program resumes exactly where it froze.
// Update types are announced by type. An active thread takes longer to finish than an inactive one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "live-"));
delete process.env.ELEVENLABS_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { newRun, tick, position, setScript, stats, REACT_MAX, FREEZE_MIN } = await import("../src/live/run.ts");
const { diff } = await import("../src/live/thread.ts");
const { makeScript, ANNOUNCE } = await import("../src/live/script.ts");
const { recall } = await import("../src/live/memory.ts");

const LIB = [
  { id: "a", title: "A", duration: 20, media: "" },
  { id: "b", title: "B", duration: 30, media: "" },
  { id: "c", title: "C", duration: 40, media: "" },
];
const IDENT = 2;
const LIBRARY = LIB.reduce((s, p) => s + p.duration + IDENT, 0); // 96 s
const line = (speaker: any, dur: number) => ({ speaker, text: "x", dur });

/** Drive a run on a fake clock. `arrivals`: [seconds, update]; `reactSecs`: each reaction's raw length. */
function simulate(arrivals: Array<[number, any]>, opts: { reactSecs?: number; prepareSecs?: number } = {}) {
  const t0 = 1_000_000;
  const s = newRun("T", "1", LIB, t0, IDENT);
  const pending: Array<{ at: number; n: number }> = [];
  const log: Array<{ t: number; phase: string; idx: number; offset: number; n?: number }> = [];
  const events: Array<{ type: string; body: any; t: number }> = [];
  let now = t0;
  const hooks = {
    prepare: (_u: any, st: any) => pending.push({ at: now + (opts.prepareSecs ?? 0.2) * 1000, n: st.current.n }),
    onEvent: (type: string, body: any) => events.push({ type, body, t: now }),
  };
  const queue = [...arrivals].sort((a, b) => a[0] - b[0]);
  for (; s.phase !== "complete" && now < t0 + 3600_000; now += 50) {
    while (queue.length && now >= t0 + queue[0][0] * 1000) s.queue.push(queue.shift()![1]);
    for (const p of pending.filter((p) => now >= p.at)) {
      const r = opts.reactSecs ?? 12;
      setScript(s, p.n, { announce: line("MRS. BUS", 2.5), react: [line("BORGES", r * 0.5), line("AGNOLO", r * 0.3), line("LEONARDO", r * 0.2)], returnLine: line("MRS. BUS", 2.8), memory: [] });
      pending.splice(pending.indexOf(p), 1);
    }
    tick(s, now, hooks);
    const pos = position(s, now);
    log.push({ t: (now - t0) / 1000, phase: s.phase, idx: pos.idx, offset: pos.offset, n: s.current?.n });
  }
  return { s, log, events, elapsed: (s.completedAt! - t0) / 1000 };
}
const u = (type: any, extra = {}) => ({ id: `${type}:${Math.random()}`, type, at: "", ...extra });

test("ACCEPTANCE 1: each interrupt is freeze -> announce -> react -> return, then resumes where it froze", () => {
  const { s, log, events } = simulate([[10, u("quote", { name: "Jim" })], [45, u("like", { count: 3 })], [70, u("reply", { name: "Steph" })]]);
  assert.equal(s.phase, "complete");
  assert.equal(s.done.length, 3);
  for (const n of [1, 2, 3]) {
    const seq = events.filter((e) => e.body.n === n).map((e) => e.type);
    assert.deepEqual(seq, ["live.freeze", "live.announce", "live.react", "live.return", "live.resume"], `interrupt ${n}`);
    const during = log.filter((l) => l.n === n && l.phase !== "playing");
    const frozen = events.find((e) => e.type === "live.freeze" && e.body.n === n)!.body.frozen;
    assert.ok(during.every((l) => l.idx === frozen.idx && l.offset === frozen.offset), `program held still during interrupt ${n}`);
    const resumed = events.find((e) => e.type === "live.resume" && e.body.n === n)!.body;
    assert.deepEqual([resumed.idx, resumed.offset], [frozen.idx, frozen.offset], `resumed where it froze (${n})`);
  }
});

test("ACCEPTANCE 2: the background freezes first, at least 1.5 s, and holds while the reaction is prepared", () => {
  const { events } = simulate([[5, u("reply", { name: "A" })]], { prepareSecs: 6 });
  const f = events.find((e) => e.type === "live.freeze")!.t, a = events.find((e) => e.type === "live.announce")!.t;
  assert.ok((a - f) / 1000 >= 6 && (a - f) / 1000 >= FREEZE_MIN);
});

test("ACCEPTANCE 3: a reaction never runs longer than 30 seconds", () => {
  const { s, events } = simulate([[5, u("reply", { name: "A" })], [40, u("quote", { name: "B" })]], { reactSecs: 55 });
  for (const e of events.filter((e) => e.type === "live.announce")) {
    const r = e.body.phases.find((p: any) => p.phase === "react");
    assert.ok((r.end - r.start) / 1000 <= REACT_MAX, `react span ${(r.end - r.start) / 1000}s`);
  }
  assert.equal(s.phase, "complete");
});

test("ACCEPTANCE 4: every update type is announced as itself", () => {
  const said = {
    reply: ANNOUNCE.reply(u("reply", { name: "Steph Curdy" })),
    quote: ANNOUNCE.quote(u("quote", { name: "Jim O'Shaughnessy" })),
    repost: ANNOUNCE.repost(u("repost", { count: 2 })),
    like: ANNOUNCE.like(u("like", { count: 1 })),
    bookmark: ANNOUNCE.bookmark(u("bookmark", { count: 3 })),
    views: ANNOUNCE.views(u("views", { count: 1000 })),
  };
  assert.match(said.reply, /A reply, from Steph Curdy/);
  assert.match(said.quote, /Jim O'Shaughnessy quoted it/);
  assert.match(said.repost, /2 new reposts/);
  assert.match(said.like, /One new like\./);
  assert.match(said.bookmark, /3 new bookmarks/);
  assert.match(said.views, /passed 1,000 views/);
});

test("ACCEPTANCE 5: the run ends with the library, and its length is library + the thread's time", () => {
  const quiet = simulate([]);
  assert.ok(Math.abs(quiet.elapsed - LIBRARY) < 0.2, `inactive: ${quiet.elapsed}s`);
  const busy = simulate([[3, u("reply", { name: "A" })], [8, u("like", { count: 1 })], [9, u("repost", { count: 1 })], [60, u("views", { count: 100 })]]);
  const added = busy.s.done.reduce((t, d) => t + (d.ended - d.began) / 1000, 0);
  assert.ok(Math.abs(busy.elapsed - (LIBRARY + added)) < 0.3, `active: ${busy.elapsed}s = ${LIBRARY} + ${added}`);
  assert.ok(busy.elapsed > quiet.elapsed + 4 * 20, "an active thread takes longer to stream against");
  const st = stats(busy.s, busy.s.completedAt!);
  assert.equal(st.interrupts, 4);
  assert.ok(st.complete && st.remaining_secs === 0);
  assert.deepEqual(st.by_type, { reply: 1, like: 1, repost: 1, views: 1 });
});

test("thread diffs become typed updates; the first look is a baseline, not news", () => {
  const p = (id: string, user: string) => ({ id, user, name: user, text: "hi", url: "", created_at: "" });
  const a = { likes: 1, reposts: 1, views: 90, replies: [], quotes: [] };
  const b = { likes: 4, reposts: 2, views: 1200, replies: [p("r1", "steph")], quotes: [p("q1", "jim")] };
  assert.deepEqual(diff(null, a), []);
  const d = diff(a, b);
  assert.deepEqual(d.map((x) => [x.type, x.count ?? x.user]), [["reply", "steph"], ["quote", "jim"], ["repost", 1], ["like", 3], ["views", 1000]]);
  assert.deepEqual(diff(b, b), []);
});

test("reactions pull memory, cite it, and book the time with real numbers", async () => {
  const s = newRun("M", "1", LIB, Date.now(), IDENT);
  const up = { id: "x", type: "reply" as const, at: "", user: "jessyka_boat", name: "Jessyka Boatright", text: "Love this experiment!" };
  assert.ok(recall(up).some((r) => r.id.startsWith("ep:the-swarm-test")), "Borges finds the episode that remembers Jessyka");
  const sc = await makeScript(up, s, 1, "This tweet is a public experiment on the value of information.");
  assert.match(sc.announce.text, /A reply, from Jessyka Boatright/);
  const borges = sc.react.filter((l) => l.speaker === "BORGES");
  assert.match(borges[0].text, /Jessyka Boatright wrote: "Love this experiment!"/);
  assert.ok(borges[1].cite?.startsWith("ep:"), "the memory line carries its record id");
  assert.match(sc.react.find((l) => l.speaker === "AGNOLO")!.text, /Interruption number 1\. The clock starts now\./);
  assert.ok(sc.react.reduce((t, l) => t + l.dur, 0) > 0);
});
