// The interrupt script. Mrs. Bus announces the update by type; Borges reads what was said (if it
// may be read) and what the library remembers, with the record cited; Agnolo books the time the
// thread has taken; Leonardo reacts. Agnolo's numbers come from code, never from a model.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DATA } from "../station/rules.ts";
import { voice } from "../station/tts.ts";
import { vet } from "../station/safety.ts";
import { speakable } from "../station/react.ts";
import { ROOT } from "../station/schedule.ts";
import { recall, threadRecords } from "./memory.ts";
import { stats } from "./run.ts";
import type { Line, RunState, Script, Update } from "./types.ts";

const plural = (n: number, one: string, many = one + "s") => (n === 1 ? `one ${one}` : `${n} ${many}`);
const cap = (t: string) => t[0].toUpperCase() + t.slice(1);
const who = (u: Update) => u.name || (u.user ? `at ${u.user}` : "someone");
export const clock = (secs: number) => { const m = Math.floor(secs / 60), s = Math.round(secs % 60); return m ? `${m} minute${m === 1 ? "" : "s"} ${s} second${s === 1 ? "" : "s"}` : `${s} seconds`; };
const words = (s: string, n: number) => { const w = s.split(/\s+/); return w.length > n ? w.slice(0, n).join(" ") + "…" : s; };

export const ANNOUNCE: Record<Update["type"], (u: Update) => string> = {
  reply: (u) => `Update on the thread! A reply, from ${who(u)}.`,
  quote: (u) => `Update on the thread! ${who(u)} quoted it.`,
  repost: (u) => `Update on the thread! ${cap(plural(u.count ?? 1, "new repost"))}.`,
  like: (u) => `Update on the thread! ${cap(plural(u.count ?? 1, "new like"))}.`,
  bookmark: (u) => `Update on the thread! ${cap(plural(u.count ?? 1, "new bookmark"))}.`,
  views: (u) => `Update on the thread! It just passed ${u.count?.toLocaleString("en-US")} views.`,
};
const LEO: Record<Update["type"], string[]> = {
  reply: ["A conversation! That's the whole movie.", "They answered! Keep the cameras rolling!"],
  quote: ["Quoted! The thread just got a second screen!", "Now it's traveling!"],
  repost: ["It's moving!", "Somebody passed it on!"],
  like: ["Every like is a frame!", "Somebody liked it! Roll on!"],
  bookmark: ["Saved for later! A future viewer!", "Bookmarked! That's a promise to come back."],
  views: ["More eyes on the screening room!", "The room is filling up!"],
};
const LEDGER: Record<Update["type"], (u: Update) => string> = {
  reply: () => "one reply", quote: () => "one quote post",
  repost: (u) => plural(u.count ?? 1, "repost"), like: (u) => plural(u.count ?? 1, "like"),
  bookmark: (u) => plural(u.count ?? 1, "bookmark"), views: (u) => `${u.count?.toLocaleString("en-US")} views`,
};

export function estimate(text: string) { return Math.max(1.2, text.split(/\s+/).length / 2.6 + 0.3); }
function probe(file: string) {
  try { return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString()) || 0; } catch { return 0; }
}

async function leonardo(u: Update, fallback: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fallback;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: key });
    const bible = readFileSync(join(ROOT, "characters/leonardo.md"), "utf8").slice(0, 2500);
    const r = await Promise.race([
      client.messages.create({
        model: process.env.CHARACTER_MODEL ?? "claude-sonnet-5-5",
        max_tokens: 80,
        system: `${bible}\n\nYou are reacting live on air to an update on a thread. One line, at most 16 words. React to the event itself. Make no claims about the person, no numbers, no promises.`,
        messages: [{ role: "user", content: `Update type: ${u.type}. ${u.text ? `What they wrote: "${u.text}"` : ""}` }],
      }),
      new Promise<never>((_, no) => setTimeout(() => no(new Error("slow")), 5000)),
    ]);
    const t = ((r as any).content?.[0]?.text ?? "").trim().replace(/^["“]|["”]$/g, "");
    return t && t.split(/\s+/).length <= 20 ? t : fallback;
  } catch { return fallback; }
}

export async function makeScript(u: Update, s: RunState, n: number, rootText = "", now = Date.now()): Promise<Script> {
  const announce: Line = { speaker: "MRS. BUS", text: ANNOUNCE[u.type](u), dur: 0 };
  const react: Line[] = [];
  const memory = recall(u, threadRecords(rootText));
  if (u.text) {
    const why = vet({ id: u.id, url: u.url ?? "", user: u.user ?? "x", name: u.name ?? "", created_at: u.at, text: u.text }, { id: "live", kind: "reply", value: "", cooldown_min: 0, enabled: true, added_at: "", source: "" }, [], now / 1000, { perAccountPerDay: 99, perDay: 999, minChars: 1, maxChars: 4000, deny: (process.env.STATION_DENY ?? "").split(",") });
    react.push({ speaker: "BORGES", text: why && !/too long/.test(why) ? `We won't read this one on air. ${why.split(":")[0]}.` : `${who(u)} wrote: "${words(speakable(u.text), 32)}"`, dur: 0 });
  }
  // Counts have no author to remember: Borges reads a short line of the thread itself instead.
  const short = threadRecords(rootText).filter((r) => r.text.split(/\s+/).length <= 16);
  const m = memory[0] ?? (!u.user && short.length ? short[(n - 1) % short.length] : undefined);
  if (m && !memory.length) memory.push(m);
  // Quote the sentence that bears on this person, not the start of a long record.
  const focus = (t: string) => {
    const sents = t.split(/(?<=[.!?])\s+/);
    const keys = [u.user, ...(u.name ?? "").split(/\s+/)].filter((k) => k && k.length > 2).map((k) => k!.toLowerCase());
    return sents.find((x) => keys.some((k) => x.toLowerCase().includes(k))) ?? sents[0];
  };
  react.push(m
    ? { speaker: "BORGES", text: m.id.startsWith("thread:") && !u.user ? `The thread says: "${words(speakable(m.text), 20)}"` : `The library remembers, from ${m.title}: ${words(speakable(focus(m.text)), 16)}`, dur: 0, cite: m.id }
    : { speaker: "BORGES", text: u.user ? `The library has no volume on ${who(u)} yet. It does now.` : "The library notes it.", dur: 0 });
  // Agnolo books it. The exact time added is on screen (it depends on this very segment's length).
  void stats;
  react.push({ speaker: "AGNOLO", text: `Ledger: ${LEDGER[u.type](u)}. Interruption number ${n}. ${n === 1 ? "The clock starts now." : "The clock is running."}`, dur: 0 });
  const pick = LEO[u.type][n % LEO[u.type].length];
  react.push({ speaker: "LEONARDO", text: await leonardo(u, pick), dur: 0 });
  const script: Script = { announce, react, returnLine: { speaker: "MRS. BUS", text: "And now, back to our regularly scheduled programming.", dur: 0 }, memory: memory.map((r) => ({ id: r.id, text: r.text })) };
  // Voices (cached lines are free; uncached ones need ELEVENLABS_API_KEY and fit under the daily cap).
  const all = [script.announce, ...script.react, script.returnLine];
  await voice({ id: `L-${s.id}-${String(n).padStart(3, "0")}`, lines: all } as any).catch(() => null);
  for (const l of all) l.dur = l.audio ? probe(join(DATA(), "audio", l.audio.split("/").pop()!)) || estimate(l.text) : estimate(l.text);
  return script;
}
