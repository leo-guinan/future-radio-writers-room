// Provider adapters. All Meta integrations sit behind these interfaces so the
// session controller and executor never touch provider APIs directly.
//
// Live transcription in the browser runs on-device (Web Speech API) by default:
// raw audio never leaves the machine. The server-side Meta adapters activate only
// when their keys are configured; otherwise the offline adapters keep the demo
// working with deterministic, $0 behavior.

import type { HumainPlanTask } from "../core/types.ts";

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
    const form = new FormData();
    form.set("request", JSON.stringify({ model: "muse-voice-transcribe-1.0" }));
    form.set("audio", new Blob([new Uint8Array(audio)], { type: mime || "audio/wav" }), "audio.wav");
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`muse-voice-transcribe-1.0: HTTP ${res.status} ${String(await res.text().catch(() => "")).slice(0, 200)}`);
    const body = (await res.json().catch(() => ({}))) as any;
    const text = String(body.text ?? body.transcript ?? body.results?.map((r: any) => r.text ?? "").join(" ") ?? "");
    const cost = Number(body.cost_usd ?? body.usage?.cost);
    return { chunks: text ? [{ text, final: true }] : [], costUsd: Number.isFinite(cost) ? cost : null };
  }
}

/** muse-voice-transcribe-1.0 realtime (Meta Model API, documented).
 * wss://api.meta.ai/v1/asr/realtime; the credential rides inside the JSON
 * handshake, audio is linear16 mono at 16 kHz. */
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
    const texts: TranscriptChunk[] = [];
    let cost: number | null = null;
    await new Promise<void>((resolve, reject) => {
      const ws = new WS(this.url);
      const fail = (e: unknown) => {
        try { ws.close(); } catch {}
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      ws.addEventListener("error", () => fail(new Error("muse-voice-transcribe-1.0/realtime: socket error")));
      ws.addEventListener("message", (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data));
          const text = String(msg.text ?? msg.transcript ?? "");
          if (text) texts.push({ text, final: msg.final === true || msg.type === "final" });
          const c = Number(msg.cost_usd ?? msg.usage?.cost);
          if (Number.isFinite(c)) cost = c;
          if (msg.type === "done") resolve();
        } catch {}
      });
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
          authorization: { accessToken: this.apiKey },
          model: "muse-voice-transcribe-1.0",
          audio: { encoding: "linear16", sampleRate, channels: 1 },
        }));
        (async () => {
          try {
            for await (const c of chunks) ws.send(c);
            ws.send(JSON.stringify({ type: "end" }));
            setTimeout(() => resolve(), 15000); // the server answers "done"; don't hang forever
          } catch (e) {
            fail(e);
          }
        })();
      });
    });
    return { chunks: texts, costUsd: cost };
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
  return MetaVoiceTranscriber.available() ? new MetaVoiceTranscriber() : new OfflineTranscriber();
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
        max_tokens: 2500,
        messages: [
          { role: "system", content: "You turn spoken ideas into structured, executable action plans. Reply with JSON only." },
          { role: "user", content: PLAN_PROMPT(idea, context.works) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`muse-spark-1.3: HTTP ${res.status} ${String(await res.text().catch(() => "")).slice(0, 200)}`);
    const body = (await res.json().catch(() => ({}))) as any;
    const raw = String(body.choices?.[0]?.message?.content ?? body.output ?? "");
    const parsed = extractDraft(raw) ?? OfflinePlanner.draft(idea, context.works);
    const usage = { input: Number(body.usage?.prompt_tokens) || 0, output: Number(body.usage?.completion_tokens) || 0 };
    const cost = Number(body.cost_usd ?? body.usage?.cost);
    return { draft: parsed, costUsd: Number.isFinite(cost) ? cost : null, usage, offline: false };
  }
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
    const parsed = extractDraft(raw) ?? OfflinePlanner.draft(idea, context.works);
    const usage = { input: Number(body.usage?.prompt_tokens) || 0, output: Number(body.usage?.completion_tokens) || 0 };
    const cost = Number(body.usage?.cost);
    return { draft: parsed, costUsd: Number.isFinite(cost) ? cost : null, usage, offline: false };
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

function extractDraft(text: string): PlanDraft | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const p = JSON.parse(candidate) as PlanDraft;
    if (typeof p.hook === "string" && Array.isArray(p.tasks) && p.tasks.length) return p;
    return null;
  } catch {
    return null;
  }
}

export function makePlanner(): Planner {
  if (SparkPlanner.available()) return new SparkPlanner();
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
