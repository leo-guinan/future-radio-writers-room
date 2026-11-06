import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "station-"));
process.env.STATION_OWNER = "leo_guinan";
delete process.env.ELEVENLABS_API_KEY;
delete process.env.MODEL_API_KEY;

const { loadLineup, onAir, grid } = await import("../src/station/schedule.ts");
const { matches, saveRules, loadRules } = await import("../src/station/rules.ts");
const { vet } = await import("../src/station/safety.ts");
const { bulletin, speakable } = await import("../src/station/react.ts");
const { parseRequest, propose, approve } = await import("../src/station/program.ts");
const { pollOnce } = await import("../src/station/watcher.ts");
const { FixtureArchive } = await import("../src/station/archive.ts");
const { events, resetCache } = await import("../src/station/log.ts");

const rule = (kind: any, value: string, extra = {}) => ({ id: `R-${kind}`, kind, value, cooldown_min: 10, enabled: true, added_at: "", source: "test", ...extra });
const post = (user: string, text: string, extra = {}) => ({ id: Math.random().toString(36).slice(2), url: "", user, name: user, created_at: "2026-11-05T15:00:00.000Z", text, ...extra });

test("the grid is continuous, clock-derived and covers 24 hours", () => {
  const l = loadLineup();
  const t = Date.parse("2026-11-06T12:00:00Z") / 1000;
  const a = onAir(l, t), b = onAir(l, t);
  assert.deepEqual(a, b);
  assert.ok(a.offset >= 0 && a.offset < a.slot.program.duration + l.ident_secs);
  const g = grid(l, t, 24);
  for (let i = 1; i < g.length; i++) assert.equal(g[i].start, g[i - 1].end + l.ident_secs);
  assert.ok(g.at(-1)!.end >= t + 24 * 3600 - 900);
});

test("spoken requests become rule changes", () => {
  assert.deepEqual(parseRequest("Leonardo, watch tenso. React whenever someone mentions me or replies to me, and listen for the phrase \"bloom party\"."), [
    { op: "add", kind: "from", value: "distributedkv", cooldown_min: undefined },
    { op: "add", kind: "mention", value: "leo_guinan", cooldown_min: undefined },
    { op: "add", kind: "reply", value: "leo_guinan", cooldown_min: undefined },
    { op: "add", kind: "keyword", value: "bloom party", cooldown_min: undefined },
  ]);
  assert.deepEqual(parseRequest("Stop watching tenso."), [{ op: "remove", value: "distributedkv" }]);
  assert.deepEqual(parseRequest("follow annalea and jessyka at most once every 60 minutes").map((o) => [o.value, o.cooldown_min]), [["annalea_l", 60], ["jessyka_boat", 60]]);
  assert.deepEqual(parseRequest("what's the weather like"), []);
});

test("rules match the posts they describe, and only those", () => {
  assert.ok(matches(rule("from", "distributedkv"), post("distributedkv", "bloom when others are dooming.")));
  assert.ok(!matches(rule("from", "distributedkv"), post("distributedkv", "RT @x: hi")));
  assert.ok(matches(rule("mention", "leo_guinan"), post("jessyka_boat", "@annalea_l @leo_guinan Awww this makes me happy")));
  assert.ok(!matches(rule("mention", "leo_guinan"), post("leo_guinan", "talking to myself @leo_guinan")));
  assert.ok(matches(rule("reply", "leo_guinan"), post("strangestloop", "@leo_guinan This is so cool!")));
  assert.ok(!matches(rule("reply", "leo_guinan"), post("x", "great thread by @leo_guinan today")));
  assert.ok(matches(rule("keyword", "bloom party"), post("x", "Everyone is invited at the Bloom party in SF")));
  assert.ok(!matches(rule("keyword", "bloom party"), post("x", "bloom when others party")));
  assert.ok(!matches(rule("from", "x", { enabled: false }), post("x", "hello there friends")));
});

test("safety: what may air without review", () => {
  const r = rule("from", "a");
  const t = 1_800_000_000;
  assert.equal(vet(post("a", "a perfectly ordinary update about the project"), r, [], t), null);
  assert.match(vet(post("a", "RT @b: something"), r, [], t)!, /retweet/);
  assert.match(vet(post("a", "https://example.com/x"), r, [], t)!, /link only/);
  assert.match(vet(post("a", "my dad is in the hospital again tonight"), r, [], t)!, /sensitive/);
  assert.match(vet(post("a", "a perfectly ordinary update"), r, [{ t: t - 60, user: "a", rule: r.id }], t)!, /cooling down/);
  const many = Array.from({ length: 3 }, (_, i) => ({ t: t - 3600 * (i + 1), user: "a", rule: "R-other" }));
  assert.match(vet(post("a", "a perfectly ordinary update"), r, many, t)!, /per-account/);
});

test("bulletins quote, label and react, without paraphrase", () => {
  const p = post("distributedkv", "everyone is invited at the Bloom party https://luma.com/x @leo_guinan", { name: "tenso" });
  const b = bulletin("B-0001", rule("keyword", "bloom party"), p);
  assert.equal(b.lines.length, 4);
  assert.deepEqual(b.lines.map((l) => l.speaker), ["MRS. BUS", "BORGES", "AGNOLO", "LEONARDO"]);
  assert.ok(b.lines[1].text.includes(`"everyone is invited at the Bloom party at leo_guinan"`));
  assert.equal(speakable("@a @b hi https://x.y there"), "hi there");
  assert.match(b.card.label, /aired without review/i);
});

test("the watcher airs, falls back across rules, skips, voices within the cap", async () => {
  resetCache();
  const t0 = Date.parse("2026-11-05T20:00:00Z");
  let clock = t0;
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const archive = new FixtureArchive([
    { ...post("distributedkv", "never leave your day zero brothers in trenches.", { name: "tenso" }), id: "1", release_at: at(10) },
    { ...post("distributedkv", "everyone is invited at the Bloom party in sf", { name: "tenso" }), id: "2", release_at: at(20) },
    { ...post("jessyka_boat", "@annalea_l @leo_guinan Awww this makes me happy."), id: "3", release_at: at(30) },
    { ...post("someone", "RT @k: full of unsaid words about @leo_guinan"), id: "4", release_at: at(40) },
    { ...post("nobody", "an unrelated post about gardening"), id: "5", release_at: at(50) },
  ], () => clock);
  const rules = [rule("from", "distributedkv"), rule("mention", "leo_guinan"), rule("keyword", "bloom party")];
  const spoken: string[] = [];
  const speak = async (_v: string, text: string) => (spoken.push(text), Buffer.from("ID3"));
  await pollOnce(archive, { now: () => clock, rules, speak });
  clock = t0 + 60_000;
  const r = await pollOnce(archive, { now: () => clock, rules, speak });
  assert.deepEqual(r.aired, ["B-0001", "B-0002", "B-0003"]);
  const bs = events().filter((e) => e.type === "bulletin").map((e: any) => [e.bulletin.post.id, e.bulletin.kind]);
  assert.deepEqual(bs, [["1", "from"], ["2", "keyword"], ["3", "mention"]]); // post 2: "from" was cooling down, "keyword" aired it
  assert.equal(events().filter((e) => e.type === "skip").length, 1); // the retweet
  assert.equal(spoken.length, 10); // 3 bulletins x 4 lines, but Agnolo's label is voiced once and then cached
  assert.ok(existsSync(join(process.env.DATA_DIR!, "station/audio/B-0001-0.mp3")));
  process.env.STATION_DAILY_CHARS = "10";
  const b = bulletin("B-9999", rules[0], post("distributedkv", "one more ordinary update"));
  const { voice } = await import("../src/station/tts.ts");
  assert.match((await voice(b, speak)).silent!, /daily voice cap/);
  const again = bulletin("B-0005", rules[0], { ...post("distributedkv", "never leave your day zero brothers in trenches."), name: "tenso" });
  assert.equal((await voice(again, null)).cached >= 2, true); // Agnolo and Leonardo lines repeat: cached, free, no key needed
  delete process.env.STATION_DAILY_CHARS;
});

test("programming: propose, approve, verify; stale contracts are refused", async () => {
  saveRules([]);
  const c = await propose({ text: "watch tenso and react when someone mentions me" });
  assert.equal(c.status, "proposed");
  assert.deepEqual(loadRules(), []); // nothing changes before approval
  const done = approve(c.id, "leo");
  assert.ok(done.verified.length === 2 && done.verified.every((v) => v.pass));
  assert.deepEqual(loadRules().map((r) => `${r.kind}:${r.value}`), ["from:distributedkv", "mention:leo_guinan"]);
  assert.throws(() => approve(c.id, "leo"), /already applied/);
  const c2 = await propose({ text: "stop watching tenso" });
  saveRules([]);
  assert.throws(() => approve(c2.id, "leo"), /stale/);
});
