// The watcher: every STATION_POLL_SECS, ask the archive about each rule, vet each new post,
// write a bulletin, voice it (within the daily cap) and append it to the log, which pushes it
// to every open frame. Unattended by design: the safety rules are the only gate.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Archive } from "./archive.ts";
import { append, events } from "./log.ts";
import { bulletin } from "./react.ts";
import { DATA, loadRules, matches, type Rule, type Tweet } from "./rules.ts";
import { vet, type Aired } from "./safety.ts";
import { voice, type Speak } from "./tts.ts";

interface State { started: Record<string, string>; polled: Record<string, string>; seen: string[]; aired: Aired[] }
const stateFile = () => join(DATA(), "watch-state.json");
function load(): State {
  return existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), "utf8")) : { started: {}, polled: {}, seen: [], aired: [] };
}
function save(s: State) {
  mkdirSync(DATA(), { recursive: true });
  s.seen = s.seen.slice(-5000);
  s.aired = s.aired.filter((a) => Date.now() / 1000 - a.t < 7 * 86400);
  writeFileSync(stateFile(), JSON.stringify(s));
}
const nextBulletinId = () => `B-${String(events().filter((e) => e.type === "bulletin").length + 1).padStart(4, "0")}`;

export async function pollOnce(archive: Archive, opts: { now?: () => number; speak?: Speak | null; rules?: Rule[] } = {}) {
  const now = opts.now ?? (() => Date.now());
  const st = load();
  const rules = (opts.rules ?? loadRules()).filter((r) => r.enabled);
  const backfill = Number(process.env.STATION_BACKFILL_HOURS ?? 0) * 3600_000;
  // Posts can reach the archive hours after they were written, so each poll looks back a window
  // (deduplicated by id) instead of trusting a strict cursor.
  const lookback = Number(process.env.STATION_LOOKBACK_HOURS ?? 6) * 3600_000;
  const aired: string[] = [];
  // 1. Collect: ask the archive once per rule.
  const found = new Map<string, Tweet>();
  for (const rule of rules) {
    // A new rule starts listening now (or STATION_BACKFILL_HOURS ago): no flood of old posts.
    const started = (st.started[rule.id] ??= new Date(now() - backfill).toISOString());
    const last = st.polled[rule.id] ? Date.parse(st.polled[rule.id]) - lookback : 0;
    const since = new Date(Math.max(Date.parse(started), last)).toISOString();
    try {
      for (const p of await archive.since(rule, since)) if (p.created_at >= started && !st.seen.includes(p.id)) found.set(p.id, p);
      st.polled[rule.id] = new Date(now()).toISOString();
    } catch (e: any) {
      append("watch.error", { rule: rule.id, error: String(e.message).slice(0, 300) });
    }
  }
  // 2. Decide: each new post once, oldest first, tried against every rule it matches, most
  //    specific first (reply, mention, from, keyword). The first rule that passes vet() airs it.
  const order: Record<string, number> = { reply: 0, mention: 1, from: 2, keyword: 3 };
  for (const p of [...found.values()].sort((x, y) => x.created_at.localeCompare(y.created_at))) {
    const hits = rules.filter((r) => matches(r, p)).sort((x, y) => order[x.kind] - order[y.kind]);
    if (!hits.length) continue;
    st.seen.push(p.id);
    const t = now() / 1000;
    let chosen: Rule | null = null;
    const reasons: string[] = [];
    for (const r of hits) {
      const why = vet(p, r, st.aired, t);
      if (!why) { chosen = r; break; }
      reasons.push(`${r.kind}:${r.value}: ${why}`);
    }
    if (!chosen) {
      append("skip", { rule: hits[0].id, post: { id: p.id, user: p.user, url: p.url }, reason: reasons.join("; ") });
      continue;
    }
    const b = bulletin(nextBulletinId(), chosen, p);
    const v = await voice(b, opts.speak === undefined ? undefined : opts.speak);
    st.aired.push({ t, user: p.user.toLowerCase(), rule: chosen.id });
    append("bulletin", { bulletin: b, voice: { chars: v.chars, cached: v.cached, silent: v.silent } });
    aired.push(b.id);
  }
  save(st);
  return { rules: rules.length, aired };
}

export function startWatcher(archive: Archive, everySecs = Number(process.env.STATION_POLL_SECS ?? 300)) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await pollOnce(archive); } catch (e: any) { append("watch.error", { error: String(e.message).slice(0, 300) }); } finally { busy = false; }
  };
  void tick();
  return setInterval(tick, everySecs * 1000).unref();
}
