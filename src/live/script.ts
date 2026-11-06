// The interrupt script. Mrs. Bus announces the update by type; Borges reads what was said (if it
// may be read) and what the library remembers, with the record cited; Agnolo books the time the
// thread has taken; Leonardo reacts. Agnolo's numbers come from code, never from a model.

import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DATA } from "../station/rules.ts";
import { voice } from "../station/tts.ts";
import { vet } from "../station/safety.ts";
import { speakable } from "../station/react.ts";
import { ROOT } from "../station/schedule.ts";
import { recall, threadRecords } from "./memory.ts";
import { Riff } from "./riff.ts";
import type { AskArchive } from "./ask.ts";
import { OWNER } from "../station/rules.ts";
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
  reair: () => "From the archive: a rerun.",
};
const LEO: Record<Update["type"], string[]> = {
  reply: ["A conversation! That's the whole movie.", "They answered! Keep the cameras rolling!"],
  quote: ["Quoted! The thread just got a second screen!", "Now it's traveling!"],
  repost: ["It's moving!", "Somebody passed it on!"],
  like: ["Every like is a frame!", "Somebody liked it! Roll on!"],
  bookmark: ["Saved for later! A future viewer!", "Bookmarked! That's a promise to come back."],
  views: ["More eyes on the screening room!", "The room is filling up!"],
  reair: ["Still good!", "Encore!"],
};
const LEDGER: Record<Update["type"], (u: Update) => string> = {
  reply: () => "one reply", quote: () => "one quote post",
  repost: (u) => plural(u.count ?? 1, "repost"), like: (u) => plural(u.count ?? 1, "like"),
  bookmark: (u) => plural(u.count ?? 1, "bookmark"), views: (u) => `${u.count?.toLocaleString("en-US")} views`,
  reair: () => "one rerun",
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

export async function voiceLines(lines: Line[], id: string) {
  if (!lines.length) return;
  await voice({ id, lines } as any).catch(() => null);
  for (const l of lines) l.dur = l.audio ? probe(join(DATA(), "audio", l.audio.split("/").pop()!)) || estimate(l.text) : estimate(l.text);
}

/** The thread sentence that names this person (or a short line of the thread for counts). */
function focusSentence(u: Update, rootText: string, n: number) {
  const sents = rootText.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const keys = [u.user, ...(u.name ?? "").split(/\s+/)].filter((k) => k && k.length > 2).map((k) => k!.toLowerCase());
  const hit = sents.find((x) => keys.some((k) => x.toLowerCase().includes(k)));
  if (hit) return { text: hit, id: `thread:${sents.indexOf(hit)}` };
  const short = sents.filter((x) => x.split(/\s+/).length <= 16 && x.length > 12);
  return short.length ? { text: short[(n - 1) % short.length], id: `thread:${sents.indexOf(short[(n - 1) % short.length])}` } : null;
}

/** The opening of a segment: the announcement, the post read as written, what the thread says.
 * The riff (questions to the archive) continues from here while it plays. */
export async function opening(u: Update, s: RunState, n: number, rootText: string, ask: AskArchive | null): Promise<{ script: Script; riff: Riff | null }> {
  const announce: Line = { speaker: "MRS. BUS", text: ANNOUNCE[u.type](u), dur: 0 };
  const react: Line[] = [];
  if (u.text) {
    const why = vet({ id: u.id, url: u.url ?? "", user: u.user ?? "x", name: u.name ?? "", created_at: u.at, text: u.text }, { id: "live", kind: "reply", value: "", cooldown_min: 0, enabled: true, added_at: "", source: "" }, [], Date.now() / 1000, { perAccountPerDay: 99, perDay: 999, minChars: 1, maxChars: 4000, deny: (process.env.STATION_DENY ?? "").split(",").filter(Boolean) });
    react.push({ speaker: "BORGES", text: why ? `We won't read this one on air. ${why.split(":")[0]}.` : `${who(u)} wrote: "${words(speakable(u.text), 40)}"`, dur: 0 });
  }
  const f = focusSentence(u, rootText, n);
  const memory = recall(u, threadRecords(rootText));
  if (f) react.push({ speaker: "BORGES", text: u.user ? `And the thread itself says: "${words(speakable(f.text), 34)}"` : `The thread says: "${words(speakable(f.text), 24)}"`, dur: 0, cite: f.id });
  else if (memory[0]) react.push({ speaker: "BORGES", text: `The library remembers, from ${memory[0].title}: ${words(speakable(memory[0].text), 24)}`, dur: 0, cite: memory[0].id });
  const riff = u.user && ask ? new Riff(u, ask, OWNER(), f?.text ?? "") : null;
  if (riff) react.push(...(await riff.next())); // the first question, so the riff is already moving
  if (!riff || riff.done) react.push(...(await improvise(u, wrap(u, n, riff))));
  const script: Script = {
    announce, react,
    returnLine: { speaker: "MRS. BUS", text: "And now, back to our regularly scheduled programming.", dur: 0 },
    memory: [...memory.map((r) => ({ id: r.id, text: r.text })), ...(f ? [{ id: f.id, text: f.text }] : [])],
    done: !riff || riff.done, turns: riff?.turns ?? 0,
  };
  await voiceLines([script.announce, ...script.react, script.returnLine], `L-${s.id}-${String(n).padStart(3, "0")}-0`);
  return { script, riff };
}

/** The closing lines: Agnolo books it, Leonardo reacts, Mrs. Bus files it for the reruns. */
export function wrap(u: Update, n: number, riff: Riff | null): Line[] {
  const q = riff ? `${plural(riff.asked, "question")} to the archive, ${plural(riff.answered, "good answer")}. ` : "";
  return [
    { speaker: "AGNOLO", text: `Ledger: ${LEDGER[u.type](u)}. Interruption number ${n}. ${q}The clock is running.`, dur: 0 },
    { speaker: "LEONARDO", text: LEO[u.type][n % LEO[u.type].length], dur: 0 },
    ...(riff ? [{ speaker: "MRS. BUS" as const, text: "That's a segment. Filed for the reruns.", dur: 0 }] : []),
  ];
}

/** Leonardo's closing line improvises when ANTHROPIC_API_KEY is set (one line, about the event). */
async function improvise(u: Update, lines: Line[]) {
  for (const l of lines) if (l.speaker === "LEONARDO") l.text = await leonardo(u, l.text);
  return lines;
}

/** The next turn of the riff (voiced), plus the wrap when the riff runs out of interesting answers. */
export async function continueRiff(u: Update, riff: Riff, s: RunState, n: number): Promise<Line[]> {
  const lines = await riff.next();
  if (riff.done) lines.push(...(await improvise(u, wrap(u, n, riff))));
  await voiceLines(lines, `L-${s.id}-${String(n).padStart(3, "0")}-${riff.turns}`);
  return lines;
}

// ---------------------------------------------------------------- segments: free to re-air

const segDir = () => join(DATA(), "segments");
export function saveSegment(runId: string, n: number, u: Update, script: Script, took: number) {
  mkdirSync(segDir(), { recursive: true });
  const id = `S-${runId}-${String(n).padStart(3, "0")}`;
  const strip = (l: Line) => ({ ...l, at: undefined });
  const seg = { id, saved: new Date().toISOString(), update: u, took_secs: Math.round(took), turns: script.turns, announce: strip(script.announce), react: script.react.map(strip), returnLine: strip(script.returnLine), memory: script.memory };
  writeFileSync(join(segDir(), `${id}.json`), JSON.stringify(seg, null, 1));
  script.segment = id;
  return id;
}
export function listSegments() {
  if (!existsSync(segDir())) return [];
  return readdirSync(segDir()).filter((f) => f.endsWith(".json")).map((f) => {
    const x = JSON.parse(readFileSync(join(segDir(), f), "utf8"));
    return { id: x.id, saved: x.saved, type: x.update.type, user: x.update.user ?? null, turns: x.turns, secs: Math.round([x.announce, ...x.react, x.returnLine].reduce((t: number, l: Line) => t + l.dur + 0.3, 0)) };
  });
}
/** A rerun: the saved lines and audio, as they aired. No archive questions, no new voices. */
export function rerun(id: string): Script {
  const x = JSON.parse(readFileSync(join(segDir(), `${basename(id)}.json`), "utf8"));
  return { announce: x.announce, react: x.react, returnLine: x.returnLine, memory: x.memory, done: true, turns: x.turns, segment: x.id };
}
