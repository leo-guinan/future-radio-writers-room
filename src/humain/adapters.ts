// Provider adapters. All Meta integrations sit behind these interfaces so the
// session controller and executor never touch provider APIs directly.
//
// Live transcription in the browser runs on-device (Web Speech API) by default:
// raw audio never leaves the machine. The server-side Meta adapters activate only
// when their keys are configured; otherwise the offline adapters keep the demo
// working with deterministic, $0 behavior.

import type { HumainPlanTask } from "../core/types.ts";
import { REVISE_SYSTEM_PROMPT, isCutRevision, reviseUserPrompt } from "./cuts.ts";
import type { CutDoc, CutRevision } from "./cuts.ts";

// ---------------------------------------------------------------- transcription

export interface TranscriptChunk {
  text: string;
  final: boolean;
}

export interface Transcriber {
  readonly id: string;
  /** Transcribe one audio blob. Offline adapters return what the client already transcribed. */
  transcribe(audio: Buffer, mime: string): Promise<{ chunks: TranscriptChunk[]; costUsd: number | null }>;
}

export const META_API_BASE = () => process.env.META_API_BASE ?? "https://api.meta.ai/v1";
export const META_API_KEY = () => process.env.MODEL_API_KEY ?? process.env.META_MODEL_API_KEY ?? "";
/** Live mode: fail visibly when Meta APIs are unavailable. Never silently swap
 * a live call for an offline stand-in. Enabled with HUMAIN_LIVE=1. */
export const isLive = () => process.env.HUMAIN_LIVE === "1";

/** muse-voice-transcribe-1.0 file transcription (Meta Model API, documented).
 * POST {base}/asr/transcribe, multipart, Bearer MODEL_API_KEY. Audio must be
 * mono 16-bit PCM WAV at 16 or 24 kHz. Keys stay server-side: this class only
 * ever runs in Node, never in the browser or the disposable workspace. */
export class MetaVoiceTranscriber implements Transcriber {
  readonly id = "muse-voice-transcribe-1.0";
  constructor(
    private apiKey = META_API_KEY(),
    private url = process.env.META_VOICE_URL ?? `${META_API_BASE()}/asr/transcribe`,
    private fetchImpl: typeof fetch = globalThis.fetch,
  ) {}
  static available(): boolean {
    return Boolean(META_API_KEY());
  }
  async transcribe(audio: Buffer, mime: string) {
    // Cookbook shape: params as a JSON part, audio as a file part.
    const form = new FormData();
    form.set("request", new Blob([JSON.stringify({ mode: "PUSH_TO_TALK", model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" })], { type: "application/json" }));
    form.set("audio", new File([new Uint8Array(audio)], "audio.wav", { type: mime || "audio/wav" }));
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`muse-voice-transcribe-1.0: HTTP ${res.status} ${String(await res.text().catch(() => "")).slice(0, 200)}`);
    const body = (await res.json().catch(() => ({}))) as any;
    const turns = Array.isArray(body.turns) ? body.turns : [];
    const text = String(body.transcript ?? turns.map((t: any) => t.transcript ?? "").join(" ") ?? "");
    const cost = Number(body.cost_usd ?? body.usage?.cost);
    return { chunks: text ? [{ text, final: true }] : [], costUsd: Number.isFinite(cost) ? cost : null };
  }
}

/** Strip a WAV container, returning raw mono 16-bit PCM (what the realtime
 * endpoint takes). Validates channels, width and sample rate like the recipe. */
export function wavToPcm(wav: Buffer, wantRate = 16000): Buffer {
  const ascii = (o: number, n: number) => wav.subarray(o, o + n).toString("ascii");
  if (wav.length < 44 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") throw new Error("Not a WAV file.");
  let off = 12;
  let rate = 0;
  let channels = 0;
  let width = 0;
  let data: Buffer | null = null;
  while (off + 8 <= wav.length) {
    const id = ascii(off, 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = wav.readUInt16LE(off + 10);
      rate = wav.readUInt32LE(off + 12);
      width = wav.readUInt16LE(off + 22) / 8;
      if (wav.readUInt16LE(off + 8) !== 1) throw new Error("WAV must be PCM.");
    } else if (id === "data") {
      data = wav.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error("WAV has no data chunk.");
  const problems: string[] = [];
  if (channels !== 1) problems.push(`${channels} channels (need mono)`);
  if (width !== 2) problems.push(`${width * 8}-bit samples (need 16-bit)`);
  if (rate !== wantRate) problems.push(`${rate} Hz (need ${wantRate} Hz)`);
  if (problems.length) throw new Error(`WAV: ${problems.join(", ")}. Convert: ffmpeg -i in.wav -ac 1 -ar ${wantRate} -sample_fmt s16 out.wav`);
  return Buffer.from(data);
}

/** muse-voice-transcribe-1.0 realtime (Meta Model API, documented).
 * Follows the cookbook recipe: credential inside the JSON handshake, enum
 * fields as NAME strings, raw PCM binary frames, {"type":"endStream"} to
 * half-close, handshake ack read before audio. */
export class MetaRealtimeTranscriber {
  readonly id = "muse-voice-transcribe-1.0/realtime";
  constructor(
    private apiKey = META_API_KEY(),
    private url = process.env.META_VOICE_WS_URL ?? "wss://api.meta.ai/v1/asr/realtime",
  ) {}
  static available(): boolean {
    return Boolean(META_API_KEY()) && typeof WebSocket !== "undefined";
  }
  async transcribeStream(chunks: AsyncIterable<Buffer>, sampleRate = 16000): Promise<{ chunks: TranscriptChunk[]; costUsd: number | null }> {
    const WS = globalThis.WebSocket;
    if (!WS) throw new Error("WebSocket unavailable in this runtime.");
    const encoding = sampleRate === 24000 ? "PCM_24KHZ" : "PCM_16KHZ";
    const texts: TranscriptChunk[] = [];
    let cost: number | null = null;
    await new Promise<void>((resolve, reject) => {
      const ws = new WS(this.url);
      let settled = false;
      let acked = false;
      const done = () => {
        if (settled) return;
        settled = true;
        try { ws.close(1000); } catch {}
        resolve();
      };
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      const timer = setTimeout(() => fail(new Error("muse-voice-transcribe-1.0/realtime: timed out waiting for the server")), 120000);
      ws.addEventListener("error", () => fail(new Error("muse-voice-transcribe-1.0/realtime: socket error")));
      ws.addEventListener("close", (ev: CloseEvent) => {
        clearTimeout(timer);
        if (settled) return;
        if (ev.code === 1000) done();
        else fail(new Error(`muse-voice-transcribe-1.0/realtime: closed [${ev.code}] ${ev.reason || "unexpectedly"}`));
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (!acked) {
            acked = true;
            if (msg.type === "error") return void fail(new Error(`muse-voice-transcribe-1.0/realtime: handshake rejected: ${msg.message ?? "unknown"}`));
            return; // bare {sessionId} ack is the happy path
          }
          const text = String(msg.transcript ?? msg.text ?? "");
          if (text && msg.type !== "error") texts.push({ text, final: msg.type === "final" || msg.final === true || msg.isFinal === true });
          const c = Number(msg.cost_usd ?? msg.usage?.cost);
          if (Number.isFinite(c)) cost = c;
          if (msg.type === "error") fail(new Error(`muse-voice-transcribe-1.0/realtime: ${msg.message ?? "unknown transcription error"}`));
          if (msg.type === "done" || msg.type === "end" || msg.type === "complete") done();
        } catch {}
      });
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
          mode: "PUSH_TO_TALK",
          authorization: { accessToken: this.apiKey },
          audioEncoding: encoding,
          model: "muse-voice-transcribe-1.0",
          partialMode: "CUMULATIVE",
          emitAudioProgress: false,
        }));
        (async () => {
          try {
            for await (const c of chunks) ws.send(c);
            ws.send(JSON.stringify({ type: "endStream" }));
          } catch (e) {
            fail(e);
          }
        })();
      });
    });
    // CUMULATIVE partials each replace the last: keep finals plus the longest
    // trailing partial, so callers don't ingest the same words repeatedly.
    const finals = texts.filter((t) => t.final).map((t) => t.text);
    const partials = texts.filter((t) => !t.final).map((t) => t.text);
    const merged = [...finals];
    if (partials.length && !finals.some((f) => f.includes(partials[partials.length - 1]))) merged.push(partials[partials.length - 1]);
    return { chunks: merged.map((text) => ({ text, final: true })), costUsd: cost };
  }
}

/** Offline stand-in: the browser already transcribed on-device; the server just validates. */
export class OfflineTranscriber implements Transcriber {
  readonly id = "browser-speech/offline";
  async transcribe(_audio: Buffer, _mime: string) {
    return { chunks: [] as TranscriptChunk[], costUsd: 0 };
  }
}

export function makeTranscriber(): Transcriber {
  if (MetaVoiceTranscriber.available()) return new MetaVoiceTranscriber();
  if (isLive()) throw new Error("LIVE MODE: MODEL_API_KEY is missing; refusing offline transcription.");
  return new OfflineTranscriber();
}

// ---------------------------------------------------------------- planning

export interface PlanDraft {
  hook: string;
  tasks: Array<Omit<HumainPlanTask, "taskId">>;
}

export interface Planner {
  readonly id: string;
  plan(idea: string, context: { works: Array<{ work_id: string; title: string; kind: string }> }): Promise<{
    draft: PlanDraft;
    costUsd: number | null;
    usage: { input: number; output: number };
    offline: boolean;
  }>;
}

const PLAN_PROMPT = (idea: string, works: Array<{ work_id: string; title: string; kind: string }>) =>
  `Turn this spoken idea into a structured action plan. The system publishes persistent, shareable comparison frames (webpages with one hook and a vintage visitor counter each). Use capability "catalog-works" once for reuse, then one "frame.build" task per frame (each with its own hook and two work ids from the catalog below), then "verify". Reply with JSON only: {"hook":"","tasks":[{"title":"","kind":"reuse|build","capability":"","detail":"","decision?":"","frame?":{"hook":"","workA":"","workB":""},"estApiUsd":0,"estHours":0,"estSeconds":0}]}. Idea: ${idea}. Catalog: ${JSON.stringify(works.map((w) => ({ work_id: w.work_id, title: w.title })))}`;

/** muse-spark-1.3 for structured planning (Meta Model API, documented).
 * POST {base}/chat/completions, OpenAI-compatible, Bearer [REDACTED] Server-side only. */
export class SparkPlanner implements Planner {
  readonly id = "muse-spark-1.3";
  constructor(
    private apiKey = META_API_KEY(),
    private url = process.env.META_SPARK_URL ?? `${META_API_BASE()}/chat/completions`,
    private fetchImpl: typeof fetch = globalThis.fetch,
  ) {}
  static available(): boolean {
    return Boolean(META_API_KEY());
  }
  async plan(idea: string, context: { works: Array<{ work_id: string; title: string; kind: string }> }) {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        max_tokens: 8000, // reasoning tokens share this budget; content needs room after them
        messages: [
          { role: "system", content: "You turn spoken ideas into structured, executable action plans. Reply with JSON only." },
          { role: "user", content: PLAN_PROMPT(idea, context.works) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`muse-spark-1.3: HTTP ${res.status} ${String(await res.text().catch(() => "")).slice(0, 200)}`);
    const body = (await res.json().catch(() => ({}))) as any;
    const raw = String(body.choices?.[0]?.message?.content ?? body.output ?? "");
    const parsed = extractDraft<PlanDraft>(raw);
    if (!isPlanDraft(parsed) && isLive()) throw new Error("LIVE MODE: muse-spark-1.3 returned an unparseable plan; refusing offline fallback.");
    const draft = isPlanDraft(parsed) ? parsed : OfflinePlanner.draft(idea, context.works);
    const usage = { input: Number(body.usage?.prompt_tokens) || 0, output: Number(body.usage?.completion_tokens) || 0 };
    const cost = Number(body.cost_usd ?? body.usage?.cost);
    return { draft, costUsd: Number.isFinite(cost) ? cost : null, usage, offline: false };
  }

  /** Draft a code-change contract from a spoken request plus observed repo state.
   * Always live: there is no offline code planner, so an unparseable reply is a
   * visible failure, never a silent substitution. */
  async planCode(idea: string, observed: { facts: string[]; reuse: Array<{ capability: string; source: string; evidence: string }>; code: string }): Promise<{
    draft: CodeContractDraft;
    costUsd: number | null;
    usage: { input: number; output: number };
  }> {
    const checks = "task.evidence (target: task id; passes when that task has a success result with evidence), frame.exists, frame.hook, frame.counter, frame.works, frame.serves (target: frame id), catalog.reused (target: task id), workspace.file (target: task id, expected: path)";
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        max_tokens: 8000, // reasoning tokens share this budget; content needs room after them
        messages: [
          { role: "system", content: "You turn spoken change requests into explicit change contracts against observed code. Reply with JSON only." },
          {
            role: "user",
            content: `Spoken request: ${idea}\n\nObserved state:\n${observed.facts.join("\n")}\n\nReusable capabilities:\n${observed.reuse.map((r) => `- ${r.capability} (${r.source}): ${r.evidence}`).join("\n")}\n\nRelevant code:\n${observed.code.slice(0, 6000)}\n\nReply with JSON only: {"desired":"","satisfied":[],"modifications":[{"title":"","detail":"","estHours":0}],"missing":[],"acceptance":[{"description":"","check":"","target":"","expected":""}],"reusable":[{"capability":"","source":"","evidence":""}]}. Available acceptance checks: ${checks}. Acceptance targets that name tasks use TASK1, TASK2, ... in plan order (ids are assigned later).`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`muse-spark-1.3 planCode: HTTP ${res.status} ${String(await res.text().catch(() => "")).slice(0, 200)}`);
    const body = (await res.json().catch(() => ({}))) as any;
    const raw = String(body.choices?.[0]?.message?.content ?? body.output ?? "");
    const draft = extractDraft<CodeContractDraft>(raw);
    if (!draft || typeof draft.desired !== "string" || !Array.isArray(draft.modifications) || !draft.modifications.length || !Array.isArray(draft.acceptance) || !draft.acceptance.length)
      throw new Error(`LIVE MODE: muse-spark-1.3 returned an unusable code contract; refusing to invent one. Raw reply kept in provider logs; first 200 chars: ${raw.slice(0, 200)}`);
    const usage = { input: Number(body.usage?.prompt_tokens) || 0, output: Number(body.usage?.completion_tokens) || 0 };
    const cost = Number(body.cost_usd ?? body.usage?.cost);
    return { draft, costUsd: Number.isFinite(cost) ? cost : null, usage };
  }

  /** Draft a cut revision from spoken feedback plus the cut JSON and written critiques.
   * Always live: there is no offline revise planner, so a missing key or an
   * unparseable reply is a visible failure, never a silent substitution. */
  async planRevise(transcript: string, cut: CutDoc, critiques: string): Promise<{
    draft: CutRevision;
    costUsd: number | null;
    usage: { input: number; output: number };
  }> {
    if (!this.apiKey)
      throw new Error("Cut revision needs muse-spark-1.3 (MODEL_API_KEY). No offline revise planner exists; refusing to invent edits.");
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        max_tokens: 8000, // reasoning tokens share this budget; content needs room after them
        messages: [
          { role: "system", content: REVISE_SYSTEM_PROMPT },
          { role: "user", content: reviseUserPrompt(transcript, cut, critiques) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`muse-spark-1.3 planRevise: HTTP ${res.status} ${String(await res.text().catch(() => "")).slice(0, 200)}`);
    const body = (await res.json().catch(() => ({}))) as any;
    const raw = String(body.choices?.[0]?.message?.content ?? body.output ?? "");
    const draft = extractDraft<CutRevision>(raw);
    if (!isCutRevision(draft))
      throw new Error(`LIVE MODE: muse-spark-1.3 returned an unusable revision; refusing to invent one. First 200 chars: ${raw.slice(0, 200)}`);
    const usage = { input: Number(body.usage?.prompt_tokens) || 0, output: Number(body.usage?.completion_tokens) || 0 };
    const cost = Number(body.cost_usd ?? body.usage?.cost);
    return { draft, costUsd: Number.isFinite(cost) ? cost : null, usage };
  }
}

export interface CodeContractDraft {
  desired: string;
  satisfied: string[];
  modifications: Array<{ title: string; detail: string; estHours: number }>;
  missing: string[];
  acceptance: Array<{ description: string; check: string; target: string; expected: string }>;
  reusable: Array<{ capability: string; source: string; evidence: string }>;
}

/** Same weights, alternate route: meta/muse-spark-1.3 via OpenRouter.
 * Used only when no Meta key is configured; the planner id says so honestly. */
export class OpenRouterSparkPlanner implements Planner {
  readonly id = "openrouter/meta-muse-spark-1.3";
  constructor(
    private apiKey = process.env.OPENROUTER_API_KEY ?? "",
    private fetchImpl: typeof fetch = globalThis.fetch,
  ) {}
  static available(): boolean {
    return Boolean(process.env.OPENROUTER_API_KEY);
  }
  async plan(idea: string, context: { works: Array<{ work_id: string; title: string; kind: string }> }) {
    const res = await this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "meta/muse-spark-1.3",
        max_tokens: 2500,
        messages: [
          { role: "system", content: "You turn spoken ideas into structured, executable action plans. Reply with JSON only." },
          { role: "user", content: PLAN_PROMPT(idea, context.works) },
        ],
        usage: { include: true },
      }),
    });
    if (!res.ok) throw new Error(`openrouter/meta-muse-spark-1.3: HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as any;
    const raw = String(body.choices?.[0]?.message?.content ?? "");
    const parsed = extractDraft<PlanDraft>(raw);
    const draft = isPlanDraft(parsed) ? parsed : OfflinePlanner.draft(idea, context.works);
    const usage = { input: Number(body.usage?.prompt_tokens) || 0, output: Number(body.usage?.completion_tokens) || 0 };
    const cost = Number(body.usage?.cost);
    return { draft, costUsd: Number.isFinite(cost) ? cost : null, usage, offline: false };
  }
}

/** Offline rule-based planner: deterministic, $0, and honest about what it matched. */
export class OfflinePlanner implements Planner {
  readonly id = "offline/spark-fallback";
  async plan(idea: string, context: { works: Array<{ work_id: string; title: string; kind: string }> }) {
    return { draft: OfflinePlanner.draft(idea, context.works), costUsd: 0, usage: { input: 0, output: 0 }, offline: true };
  }

  static draft(idea: string, works: Array<{ work_id: string; title: string; kind: string }>): PlanDraft {
    const [hookA, hookB] = pickHooks(idea);
    const [a, b] = pickWorks(idea, works);
    const rest = works.filter((w) => w.work_id !== a.work_id && w.work_id !== b.work_id);
    const c = rest[0] ?? a;
    const d = rest[1] ?? b;
    return {
      hook: hookA,
      tasks: [
        {
          title: `Frame ${a.title} against ${b.title}`,
          kind: "reuse",
          capability: "catalog-works",
          detail: `Reuse catalog entries ${a.work_id} and ${b.work_id} (titles, runtimes, links) as the comparison data.`,
          estApiUsd: 0,
          estHours: 0.1,
          estSeconds: 5,
        },
        {
          title: `Publish frame: "${hookA.slice(0, 60)}"`,
          kind: "build",
          capability: "frame.build",
          detail: `Persistent, shareable frame comparing ${a.work_id} and ${b.work_id} with its own hook and visit count.`,
          frame: { hook: hookA, workA: a.work_id, workB: b.work_id },
          estApiUsd: 0,
          estHours: 0.3,
          estSeconds: 20,
        },
        {
          title: `Publish frame: "${hookB.slice(0, 60)}"`,
          kind: "build",
          capability: "frame.build",
          detail: `Second persistent frame comparing ${c.work_id} and ${d.work_id} with an independent hook and visit count.`,
          frame: { hook: hookB, workA: c.work_id, workB: d.work_id },
          estApiUsd: 0,
          estHours: 0.3,
          estSeconds: 20,
        },
        {
          title: "Verify published frames",
          kind: "reuse",
          capability: "verify",
          detail: "Each frame exists, carries its hook, has a counter, and serves. No success claim without these.",
          estApiUsd: 0,
          estHours: 0.1,
          estSeconds: 10,
        },
      ],
    };
  }
}

function pickHook(idea: string): string {
  return pickHooks(idea)[0];
}

function pickHooks(idea: string): [string, string] {
  const quoted = [...idea.matchAll(/["“]([^"”]{8,140})["”]/g)].map((m) => m[1].trim());
  const sentences = idea.split(/[.!?\n]/).map((s) => s.trim()).filter((s) => s.length >= 8);
  const first = (quoted[0] ?? sentences[0] ?? "Two transmissions, one frequency.").slice(0, 140);
  const second = (quoted[1] ?? sentences[1] ?? `Another frequency: ${first}`).slice(0, 140);
  return [first, second === first ? ` Second look: ${first}`.slice(0, 140) : second];
}

function pickWorks(idea: string, works: Array<{ work_id: string; title: string; kind: string }>) {
  const low = idea.toLowerCase();
  const scored = works.map((w) => ({
    w,
    score: w.title.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3 && low.includes(t)).length + (low.includes(w.work_id.toLowerCase()) ? 3 : 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.filter((s) => s.score > 0).map((s) => s.w);
  for (const s of scored) if (picked.length < 2 && !picked.includes(s.w)) picked.push(s.w);
  while (picked.length < 2) picked.push({ work_id: "unknown", title: "An unmade episode", kind: "episode" });
  return [picked[0], picked[1]];
}

function extractDraft<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

function isPlanDraft(p: unknown): p is PlanDraft {
  const d = p as PlanDraft;
  return typeof d?.hook === "string" && Array.isArray(d?.tasks) && d.tasks.length > 0;
}

export function makePlanner(): Planner {
  if (SparkPlanner.available()) return new SparkPlanner();
  if (isLive()) throw new Error("LIVE MODE: MODEL_API_KEY is missing; refusing fallback planners.");
  if (OpenRouterSparkPlanner.available()) return new OpenRouterSparkPlanner();
  return new OfflinePlanner();
}

// ---------------------------------------------------------------- image generation (second stage)

export interface ImageGen {
  readonly id: string;
  generate(prompt: string): Promise<{ bytes: Buffer | null; costUsd: number | null; note: string }>;
}

/** Meta image generation as a second-stage capability. Stub until META_IMAGE_URL is set. */
export class MetaImageGen implements ImageGen {
  readonly id = "meta-image-gen/stub";
  async generate(prompt: string) {
    if (!process.env.META_IMAGE_URL) return { bytes: null, costUsd: 0, note: `Image generation not configured; skipped: ${prompt.slice(0, 80)}` };
    return { bytes: null, costUsd: null, note: "Image endpoint configured but not implemented in this prototype." };
  }
}
