// Programming the station by voice, through the HumAIn loop: speak a request, get a change
// contract (observed rules, desired rules, the exact changes, the voice budget they imply and the
// acceptance checks), approve it, and it is applied and verified. Same shape as HumAIn's code and
// cut contracts: nothing changes until a human approves, and every step lands in the log.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { META_API_KEY, makeTranscriber, wavToPcm } from "../humain/adapters.ts";
import { append, events } from "./log.ts";
import { OWNER, ROOT_ALIASES, loadRules, nextRuleId, saveRules, type Rule, type RuleKind } from "./rules.ts";

export interface Op { op: "add" | "remove"; kind?: RuleKind; value: string; cooldown_min?: number }
export interface Contract {
  id: string;
  transcript: string;
  heard_by: string;
  parser: string;
  observed: Rule[];
  ops: Op[];
  desired: Rule[];
  unchanged: string[];
  estimate: { chars_per_bulletin: number; daily_cap_chars: number; max_bulletins_per_day: number };
  acceptance: string[];
  status: "proposed" | "applied" | "rejected";
}

function aliases(): Record<string, string> {
  const f = join(ROOT_ALIASES(), "station/aliases.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}
function handle(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/^(at|@)\s*/, "").replace(/[.,!?'"]+$/g, "");
  const a = aliases();
  if (s === "me" || s === "us" || s === "myself") return OWNER();
  if (a[s]) return a[s] === "$OWNER" ? OWNER() : a[s];
  return /^[a-z0-9_]{1,15}$/.test(s) ? s : null;
}

/** Deterministic parser for spoken programming requests ($0, offline). Unknown phrasing yields no
 * ops rather than a guess; the contract then shows nothing to approve. */
export function parseRequest(text: string): Op[] {
  const ops: Op[] = [];
  const cool = (c: string) => Number(c.match(/(?:at most )?(?:once )?every (\d+) minutes?/i)?.[1] ?? (/once an hour/i.test(c) ? 60 : /once a day/i.test(c) ? 1440 : 0)) || undefined;
  const many = (raw: string) => raw.split(/\s*(?:,|\band\b|\bor\b)\s*/i).map((x) => x.trim()).filter(Boolean);
  const clauses = text.split(/(?:[.;!?\n]|,?\s+and\s+(?=(?:also\s+)?(?:watch|follow|react|stop|listen|track|keep|when|whenever|if)\b)|,\s+(?=(?:watch|follow|react|stop|listen|track|keep|when|whenever|if)\b)|\s+(?:or|and)\s+(?=(?:replies|reply|responds|mentions?|tags?|says|posts about|talks about)\b))/i).map((c) => c.trim()).filter(Boolean);
  for (const c of clauses) {
    let m;
    const cooldown = cool(c);
    if ((m = c.match(/\b(?:stop|quit|no longer|don't|do not)\s+(?:watching|following|tracking|reacting to|listening (?:to|for))\s+(?:the (?:word|phrase|keyword)s?\s+)?["“]?([^"”]+?)["”]?$/i))) {
      const h = handle(m[1]);
      ops.push({ op: "remove", value: h ?? m[1].toLowerCase() });
    } else if ((m = c.match(/\b(?:replies|reply|responds?|responses)\s+to\s+(me|us|@?\s*\w+)/i))) {
      const h = handle(m[1]);
      if (h) ops.push({ op: "add", kind: "reply", value: h, cooldown_min: cooldown });
    } else if ((m = c.match(/\b(?:the (?:word|phrase|keyword)|says|posts about|talks about|mentions the (?:word|phrase))\s+["“]([^"”]+)["”]/i)) || (m = c.match(/\b(?:the (?:word|phrase|keyword))\s+([a-z0-9][\w\s-]{1,40})$/i))) {
      ops.push({ op: "add", kind: "keyword", value: m[1].trim().toLowerCase(), cooldown_min: cooldown });
    } else if ((m = c.match(/\b(?:mentions?|tags?|names?)\s+(me|us|@?\s*[\w ]+?)(?:\s+(?:on|in|at)\b.*)?$/i))) {
      const hs = many(m[1]).map(handle);
      if (hs.every(Boolean)) for (const h of hs) ops.push({ op: "add", kind: "mention", value: h!, cooldown_min: cooldown });
      else ops.push({ op: "add", kind: "keyword", value: m[1].trim().toLowerCase(), cooldown_min: cooldown });
    } else if ((m = c.match(/\b(?:watch|follow|track|keep an eye on|listen (?:to|for)|react to|react whenever|react when)\s+(?:posts? (?:from|by)\s+)?(@?\s*[\w ]+?)(?:\s+(?:posts?|tweets?|says anything))?(?:\s+(?:at most|once|every)\b.*)?$/i))) {
      for (const h of many(m[1]).map(handle)) if (h) ops.push({ op: "add", kind: "from", value: h, cooldown_min: cooldown });
    }
  }
  return ops;
}

async function sparkParse(text: string): Promise<Op[] | null> {
  if (!META_API_KEY()) return null;
  const res = await fetch(process.env.META_SPARK_URL ?? `${process.env.META_API_BASE ?? "https://api.meta.ai/v1"}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${META_API_KEY()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "muse-spark-1.3",
      max_tokens: 4000,
      messages: [
        { role: "system", content: "Turn a spoken request into trigger-rule changes for a radio station that watches an archive of public posts. Reply with JSON only." },
        { role: "user", content: `Kinds: from (posts by a handle), mention (posts mentioning a handle), reply (replies to a handle), keyword (a phrase). The owner is @${OWNER()} ("me"). Known names: ${JSON.stringify(aliases())}. Reply {"ops":[{"op":"add|remove","kind":"from|mention|reply|keyword","value":"handle or phrase","cooldown_min":30}]}. Request: ${text}` },
      ],
    }),
  });
  if (!res.ok) return null;
  const raw = String(((await res.json()) as any).choices?.[0]?.message?.content ?? "");
  try {
    const ops = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)).ops;
    return Array.isArray(ops) ? ops.filter((o: any) => (o.op === "add" && ["from", "mention", "reply", "keyword"].includes(o.kind) && o.value) || (o.op === "remove" && o.value)) : null;
  } catch {
    return null;
  }
}

const nextId = () => `P-${String(events().filter((e) => e.type === "program.proposed").length + 1).padStart(4, "0")}`;
const key = (r: { kind?: string; value: string }) => `${r.kind}:${r.value.toLowerCase()}`;

async function elevenLabsHear(audio: Buffer): Promise<string> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("Voice programming needs MODEL_API_KEY (Meta) or ELEVENLABS_API_KEY to transcribe; or send text.");
  const form = new FormData();
  form.set("model_id", process.env.STATION_STT_MODEL ?? "scribe_v1");
  form.set("file", new File([new Uint8Array(audio)], "request.wav", { type: "audio/wav" }));
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: form });
  if (!r.ok) throw new Error(`ElevenLabs speech-to-text HTTP ${r.status}`);
  return String(((await r.json()) as any).text ?? "").trim();
}

/** Spoken (or typed) request -> proposed contract. Audio is transcribed and dropped, never stored. */
export async function propose(input: { text?: string; wav?: Buffer }): Promise<Contract> {
  let transcript = input.text?.trim() ?? "";
  let heardBy = "typed";
  if (input.wav) {
    // HumAIn's transcriber (Meta muse-voice-transcribe) when MODEL_API_KEY is set; otherwise
    // ElevenLabs speech-to-text, since the station already holds that key for the cast's voices.
    const heard = META_API_KEY() ? (await makeTranscriber().transcribe(input.wav, "audio/wav")).chunks.map((c) => c.text).join(" ").trim() : await elevenLabsHear(input.wav);
    if (heard) { transcript = heard; heardBy = META_API_KEY() ? "muse-voice-transcribe-1.0" : "elevenlabs scribe_v1"; }
    void wavToPcm;
  }
  if (!transcript) throw new Error("Nothing to program: no transcript (set MODEL_API_KEY for voice, or send text).");
  const spark = await sparkParse(transcript).catch(() => null);
  const ops = spark ?? parseRequest(transcript);
  const observed = loadRules();
  let desired = observed.map((r) => ({ ...r }));
  const now = new Date().toISOString();
  const id = nextId();
  for (const o of ops) {
    if (o.op === "remove") desired = desired.filter((r) => r.value.toLowerCase() !== o.value.toLowerCase());
    else if (!desired.some((r) => key(r) === key(o)))
      desired.push({ id: nextRuleId(desired), kind: o.kind!, value: o.value, cooldown_min: o.cooldown_min ?? 10, enabled: true, added_at: now, source: `voice:${id}` });
  }
  const chars = 330; // four template lines plus a typical post
  const c: Contract = {
    id,
    transcript,
    heard_by: heardBy,
    parser: spark ? "muse-spark-1.3" : "offline rules ($0)",
    observed,
    ops,
    desired,
    unchanged: observed.filter((r) => desired.some((d) => d.id === r.id)).map((r) => r.id),
    estimate: { chars_per_bulletin: chars, daily_cap_chars: Number(process.env.STATION_DAILY_CHARS ?? 20000), max_bulletins_per_day: Number(process.env.STATION_PER_DAY ?? 24) },
    acceptance: [
      ...desired.filter((d) => !observed.some((o) => o.id === d.id)).map((d) => `rule ${key(d)} is active`),
      ...observed.filter((o) => !desired.some((d) => d.id === o.id)).map((o) => `rule ${key(o)} is gone`),
    ],
    status: "proposed",
  };
  append("program.proposed", { contract: c });
  return c;
}

export function contract(id: string): Contract | null {
  const e = [...events()].reverse().find((x) => (x.type === "program.proposed" || x.type === "program.applied") && (x as any).contract.id === id);
  return e ? ((e as any).contract as Contract) : null;
}

/** Approve: apply the desired rules, then check every acceptance line against what is on disk. */
export function approve(id: string, by: string): Contract & { verified: Array<{ check: string; pass: boolean }> } {
  const c = contract(id);
  if (!c) throw new Error(`No contract ${id}`);
  if (c.status !== "proposed") throw new Error(`${id} is already ${c.status}`);
  if (JSON.stringify(loadRules()) !== JSON.stringify(c.observed)) throw new Error(`${id} is stale: the rules changed since it was proposed. Propose again.`);
  saveRules(c.desired);
  const now = loadRules();
  const verified = c.acceptance.map((check) => {
    const [, k, gone] = check.match(/^rule (.+) is (active|gone)$/) ?? [];
    const has = now.some((r) => key(r) === k && r.enabled);
    return { check, pass: gone === "gone" ? !has : has };
  });
  const done = { ...c, status: "applied" as const, verified };
  append("program.applied", { contract: done, by });
  for (const o of c.ops) append(o.op === "add" ? "rule.added" : "rule.removed", { by, program: id, kind: o.kind, value: o.value });
  return done;
}
