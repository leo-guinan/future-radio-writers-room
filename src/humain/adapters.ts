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

/** muse-voice-transcribe-1.0. Active only with META_VOICE_API_KEY + META_VOICE_URL. */
export class MetaVoiceTranscriber implements Transcriber {
  readonly id = "muse-voice-transcribe-1.0";
  constructor(
    private apiKey = process.env.META_VOICE_API_KEY ?? "",
    private url = process.env.META_VOICE_URL ?? "",
    private fetchImpl: typeof fetch = globalThis.fetch,
  ) {}
  static available(): boolean {
    return Boolean(process.env.META_VOICE_API_KEY && process.env.META_VOICE_URL);
  }
  async transcribe(audio: Buffer, mime: string) {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": mime || "audio/webm" },
      body: new Uint8Array(audio) as unknown as BodyInit,
    });
    if (!res.ok) throw new Error(`muse-voice-transcribe-1.0: HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as any;
    const text = String(body.text ?? body.transcript ?? "");
    const cost = Number(body.cost_usd);
    return { chunks: text ? [{ text, final: true }] : [], costUsd: Number.isFinite(cost) ? cost : null };
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
  plan(idea: string, context: { works: Array<{ work_id: string; title: string; kind: string }> }): Promise<{ draft: PlanDraft; costUsd: number | null; offline: boolean }>;
}

/** muse-spark-1.3 for structured planning. Active only with META_SPARK_API_KEY + META_SPARK_URL. */
export class SparkPlanner implements Planner {
  readonly id = "muse-spark-1.3";
  constructor(
    private apiKey = process.env.META_SPARK_API_KEY ?? "",
    private url = process.env.META_SPARK_URL ?? "",
    private fetchImpl: typeof fetch = globalThis.fetch,
  ) {}
  static available(): boolean {
    return Boolean(process.env.META_SPARK_API_KEY && process.env.META_SPARK_URL);
  }
  async plan(idea: string, context: { works: Array<{ work_id: string; title: string; kind: string }> }) {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        input: `Turn this spoken idea into a structured action plan of reuse/build tasks with estimates. Idea: ${idea}. Available works: ${JSON.stringify(context.works)}. Reply with JSON: {"hook":"","tasks":[{"title":"","kind":"reuse|build","capability":"","detail":"","decision?":"","estApiUsd":0,"estHours":0,"estSeconds":0}]}`,
      }),
    });
    if (!res.ok) throw new Error(`muse-spark-1.3: HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as any;
    const raw = typeof body.output === "string" ? body.output : JSON.stringify(body.output ?? body);
    const parsed = extractDraft(raw) ?? OfflinePlanner.draft(idea, context.works);
    const cost = Number(body.cost_usd);
    return { draft: parsed, costUsd: Number.isFinite(cost) ? cost : null, offline: false };
  }
}

/** Offline rule-based planner: deterministic, $0, and honest about what it matched. */
export class OfflinePlanner implements Planner {
  readonly id = "offline/spark-fallback";
  async plan(idea: string, context: { works: Array<{ work_id: string; title: string; kind: string }> }) {
    return { draft: OfflinePlanner.draft(idea, context.works), costUsd: 0, offline: true };
  }

  static draft(idea: string, works: Array<{ work_id: string; title: string; kind: string }>): PlanDraft {
    const hook = pickHook(idea);
    const [a, b] = pickWorks(idea, works);
    return {
      hook,
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
          title: "Build the comparison page",
          kind: "build",
          capability: "frame-maker",
          detail: `One static page: the hook as headline, both works side by side. Hook: "${hook}"`,
          estApiUsd: 0,
          estHours: 0.5,
          estSeconds: 30,
        },
        {
          title: "Add the vintage visitor counter",
          kind: "build",
          capability: "visitor-counter",
          detail: "Odometer-style counter, persisted per browser, styled like a 1996 guestbook.",
          estApiUsd: 0,
          estHours: 0.2,
          estSeconds: 15,
        },
        {
          title: "Verify with evidence",
          kind: "reuse",
          capability: "evidence-checks",
          detail: "File exists, hook present, counter markup present, sha256 recorded. No success claim without these.",
          estApiUsd: 0,
          estHours: 0.1,
          estSeconds: 10,
        },
      ],
    };
  }
}

function pickHook(idea: string): string {
  const quoted = idea.match(/["“]([^"”]{8,140})["”]/);
  if (quoted) return quoted[1].trim();
  const first = idea.split(/[.!?\n]/).map((s) => s.trim()).find((s) => s.length >= 8);
  return (first ?? "Two transmissions, one frequency.").slice(0, 140);
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
  return SparkPlanner.available() ? new SparkPlanner() : new OfflinePlanner();
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
