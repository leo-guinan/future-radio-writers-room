// ACCEPTANCE: a live run plays the library to the end; each thread update interrupts it with
// freeze -> announce -> riff -> return, and the program resumes exactly where it froze. The riff is
// generated live from questions to the archive and runs as long as the answers are interesting.
// Update types are announced by type. An active thread takes longer to finish than an inactive one.
// Every segment is saved, and re-airs without generating anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "live-"));
delete process.env.ELEVENLABS_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { newRun, tick, position, setScript, extend, stats, RIFF_LIMIT, FREEZE_MIN } = await import("../src/live/run.ts");
const { diff } = await import("../src/live/thread.ts");
const { opening, continueRiff, ANNOUNCE, saveSegment, rerun, listSegments } = await import("../src/live/script.ts");
const { FixtureAsk } = await import("../src/live/ask.ts");
const ASK = new URL("./fixtures/ask-jim.json", import.meta.url).pathname;
const { recall } = await import("../src/live/memory.ts");

const LIB = [
  { id: "a", title: "A", duration: 20, media: "" },
  { id: "b", title: "B", duration: 30, media: "" },
  { id: "c", title: "C", duration: 40, media: "" },
];
const IDENT = 2;
const LIBRARY = LIB.reduce((s, p) => s + p.duration + IDENT, 0); // 96 s
const line = (speaker: any, dur: number) => ({ speaker, text: "x", dur });

/** Drive a run on a fake clock. Each segment is a riff of `turns` turns (one arrives every 4 s of
 * generation); `never` makes a riff that never wraps (to test the safety ceiling). */
function simulate(arrivals: Array<[number, any]>, opts: { turns?: number; prepareSecs?: number; never?: boolean } = {}) {
  const t0 = 1_000_000;
  const s = newRun("T", "1", LIB, t0, IDENT);
  const pending: Array<{ at: number; n: number }> = [];
  const riffs = new Map<number, { left: number; next: number }>();
  const log: Array<{ t: number; phase: string; idx: number; offset: number; n?: number }> = [];
  const events: Array<{ type: string; body: any; t: number }> = [];
  let now = t0;
  const hooks = {
    prepare: (_u: any, st: any) => pending.push({ at: now + (opts.prepareSecs ?? 0.2) * 1000, n: st.current.n }),
    onEvent: (type: string, body: any) => events.push({ type, body, t: now }),
  };
  const queue = [...arrivals].sort((a, b) => a[0] - b[0]);
  for (; s.phase !== "complete" && now < t0 + 7200_000; now += 50) {
    while (queue.length && now >= t0 + queue[0][0] * 1000) s.queue.push(queue.shift()![1]);
    for (const p of pending.filter((p) => now >= p.at)) {
      const turns = opts.turns ?? 3;
      setScript(s, p.n, { announce: line("MRS. BUS", 2.5), react: [line("BORGES", 6), line("LEONARDO", 2), line("BORGES", 5)], returnLine: line("MRS. BUS", 2.8), memory: [], done: turns <= 1 && !opts.never, turns: 1 });
      riffs.set(p.n, { left: turns - 1, next: now + 4000 });
      pending.splice(pending.indexOf(p), 1);
    }
    const c = s.current;
    const r = c && riffs.get(c.n);
    if (c?.script && r && !c.script.done && now >= r.next && (r.left > 0 || opts.never)) {
      r.left--; r.next = now + 4000;
      extend(s, c.n, [line("AGNOLO", 2), line("BORGES", 7)], !opts.never && r.left <= 0, now);
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

test("ACCEPTANCE 3: the riff runs as long as it grows, ends when it wraps, and has a safety ceiling", () => {
  const short = simulate([[5, u("reply", { name: "A" })]], { turns: 1 });
  const long = simulate([[5, u("reply", { name: "A" })]], { turns: 12 });
  const took = (r: any) => r.s.done[0].ended / 1000 - r.s.done[0].began / 1000;
  assert.ok(took(long) > took(short) + 60, `a longer riff holds the air longer (${took(short)}s vs ${took(long)}s)`);
  const capped = simulate([[5, u("reply", { name: "A" })]], { never: true });
  assert.ok(capped.events.some((e) => e.type === "live.limit"), "a riff that never wraps is wrapped by the ceiling");
  const react = capped.log.filter((l) => l.phase === "react");
  assert.ok(react.at(-1)!.t - react[0].t <= RIFF_LIMIT + 0.1, "the ceiling holds");
  assert.equal(capped.s.phase, "complete");
});

test("ACCEPTANCE 3b: the cast ask the archive, and stop when the answers stop being interesting", async () => {
  const ask = FixtureAsk.fromFile(ASK);
  const s = newRun("J", "1", LIB, Date.now(), IDENT);
  const jim = { id: "q", type: "quote" as const, at: "", user: "jposhaughnessy", name: "Jim O'Shaughnessy", text: "I'm all for experiments that could help people applying for the @osvllc Fellowship.\nApplications open 01.01.2027" };
  const root = "The one I show @jposhaughnessy when I ask him if he'd like everyone who applies to the OSV fellowship to receive a personalized movie that helps them build support for their desired futures.";
  const { script, riff } = await opening(jim, s, 1, root, ask);
  const lines = [...script.react];
  while (riff && !riff.done) lines.push(...(await continueRiff(jim, riff, s, 1)));
  const asks = lines.filter((l) => l.ask);
  assert.ok(asks.length >= 3, "several questions went to the archive");
  assert.ok(ask.calls.some((c) => c.startsWith("account:")) && ask.calls.some((c) => c.startsWith("search:")), "it looked the person up and searched their history");
  const sept = lines.find((l) => l.cite === "2101376453329699121");
  assert.match(sept!.text, /Applications for 2027 open January 1, 2027/, "it found Jim's earlier post with the same date");
  // Interest: every read answer is new; after two dull answers in a row the riff wraps.
  const cites = lines.filter((l) => l.cite && /^\d+$/.test(l.cite)).map((l) => l.cite);
  assert.equal(new Set(cites).size, cites.length, "nothing is read twice");
  const dull = asks.filter((l) => !l.ask!.novel);
  assert.ok(dull.every((l) => !l.post && l.text.split(" ").length <= 8), "a dull answer gets one short line, not a reading");
  assert.ok(riff!.done && (riff!.stale >= 2 || riff!.turns === 8));
  assert.match(lines.at(-1)!.text, /Filed for the reruns/);
});

test("ACCEPTANCE 4: every update type is announced as itself", () => {
  const said = {
    reply: ANNOUNCE.reply(u("reply", { name: "Steph Curdy" })),
    quote: ANNOUNCE.quote(u("quote", { name: "Jim O'Shaughnessy" })),
    repost: ANNOUNCE.repost(u("repost", { count: 2 })),
    like: ANNOUNCE.like(u("like", { count: 1 })),
    bookmark: ANNOUNCE.bookmark(u("bookmark", { count: 3 })),
    views: ANNOUNCE.views(u("views", { count: 1000 })),
    reair: ANNOUNCE.reair(u("reair")),
  };
  assert.match(said.reply, /A reply, from Steph Curdy/);
  assert.match(said.quote, /Jim O'Shaughnessy quoted it/);
  assert.match(said.repost, /2 new reposts/);
  assert.match(said.like, /One new like\./);
  assert.match(said.bookmark, /3 new bookmarks/);
  assert.match(said.views, /passed 1,000 views/);
  assert.match(said.reair, /a rerun/);
});

test("ACCEPTANCE 5: the run ends with the library, and its length is library + the thread's time", () => {
  const quiet = simulate([]);
  assert.ok(Math.abs(quiet.elapsed - LIBRARY) < 0.2, `inactive: ${quiet.elapsed}s`);
  const busy = simulate([[3, u("reply", { name: "A" })], [8, u("like", { count: 1 })], [9, u("repost", { count: 1 })], [60, u("views", { count: 100 })]]);
  const added = busy.s.done.reduce((t, d) => t + (d.ended - d.began) / 1000, 0);
  assert.ok(Math.abs(busy.elapsed - (LIBRARY + added)) < 0.3, `active: ${busy.elapsed}s = ${LIBRARY} + ${added}`);
  assert.ok(busy.elapsed > quiet.elapsed + 4 * 15, "an active thread takes longer to stream against");
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

test("ACCEPTANCE 6: a saved segment re-airs as it aired, with no new questions and no new voices", async () => {
  const ask = FixtureAsk.fromFile(ASK);
  const s = newRun("R", "1", LIB, Date.now(), IDENT);
  const jim = { id: "q2", type: "quote" as const, at: "", user: "jposhaughnessy", name: "Jim O'Shaughnessy", text: "Applications open 01.01.2027" };
  const { script, riff } = await opening(jim, s, 1, "", ask);
  while (riff && !riff.done) script.react.push(...(await continueRiff(jim, riff, s, 1)));
  const id = saveSegment(s.id, 1, jim, script, 90);
  assert.ok(listSegments().some((x) => x.id === id));
  const calls = ask.calls.length;
  const again = rerun(id);
  assert.equal(ask.calls.length, calls, "no archive questions");
  assert.deepEqual(again.react.map((l) => [l.speaker, l.text, l.audio ?? null]), script.react.map((l) => [l.speaker, l.text, l.audio ?? null]));
  assert.ok(again.done);
});
