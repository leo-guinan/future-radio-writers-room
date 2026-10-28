// Thin model client. Every call returns usage so the accounting role can book it.
//
// Providers, in order: OpenRouter (OPENROUTER_API_KEY), where each character can run on a
// different model and the cost comes back observed; Anthropic (ANTHROPIC_API_KEY); offline,
// where characters fall back to deterministic behaviour and runs are recorded at $0.
// LLM_PROVIDER=openrouter|anthropic|offline forces one.

import Anthropic from "@anthropic-ai/sdk";

export interface Completion {
  text: string;
  usage: { input: number; output: number };
  costUsd: number | null;
  model: string;
  offline: boolean;
}

export interface LLM {
  readonly offline: boolean;
  readonly model: string;
  complete(args: CompleteArgs): Promise<Completion>;
}

export interface CompleteArgs {
  system: string;
  user: string;
  maxTokens?: number;
  /** A model for this call; the provider's default otherwise. OpenRouter ids: "vendor/model". */
  model?: string;
}

export const DEFAULT_MODEL = () => process.env.ROOM_MODEL ?? "anthropic/claude-sonnet-5.5";

/** "anthropic/claude-sonnet-5.5" → "claude-sonnet-5-5" for Anthropic's own API. */
export function anthropicId(model: string): string | null {
  if (!model.includes("/")) return model;
  if (!model.startsWith("anthropic/")) return null;
  return model.slice("anthropic/".length).replace(/\./g, "-");
}

function price(): { input: number; output: number } | null {
  const i = Number(process.env.PRICE_INPUT_PER_MTOK);
  const o = Number(process.env.PRICE_OUTPUT_PER_MTOK);
  return Number.isFinite(i) && Number.isFinite(o) && i > 0 && o > 0 ? { input: i, output: o } : null;
}

export class AnthropicLLM implements LLM {
  readonly offline = false;
  private client: Anthropic;
  readonly model: string;
  constructor(model = DEFAULT_MODEL()) {
    this.model = anthropicId(model) ?? "claude-sonnet-5-5";
    this.client = new Anthropic();
  }
  async complete({ system, user, maxTokens = 1500, model }: CompleteArgs): Promise<Completion> {
    // Anthropic's API only runs Anthropic models; anything else falls back to the default.
    const use = (model && anthropicId(model)) || this.model;
    const res = await this.client.messages.create({
      model: use,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
    const usage = { input: res.usage.input_tokens, output: res.usage.output_tokens };
    const p = price();
    const costUsd = p ? (usage.input * p.input + usage.output * p.output) / 1_000_000 : null;
    return { text, usage, costUsd, model: use, offline: false };
  }
}

/**
 * OpenRouter: one key, many models. The cost of each call comes back in the response
 * (usage.cost, in USD), so it is booked as observed rather than estimated.
 */
export class OpenRouterLLM implements LLM {
  readonly offline = false;
  constructor(
    readonly model = DEFAULT_MODEL(),
    private apiKey = process.env.OPENROUTER_API_KEY ?? "",
    private fetchImpl: typeof fetch = globalThis.fetch,
  ) {}
  async complete({ system, user, maxTokens = 1500, model }: CompleteArgs): Promise<Completion> {
    const use = model || this.model;
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "x-title": process.env.OPENROUTER_APP_TITLE ?? "Writers' room",
          ...(process.env.OPENROUTER_REFERER ? { "http-referer": process.env.OPENROUTER_REFERER } : {}),
        },
        body: JSON.stringify({
          model: use,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          usage: { include: true },
        }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok && !body.error) {
        const text = String(body.choices?.[0]?.message?.content ?? "");
        const usage = { input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0 };
        const reported = Number(body.usage?.cost);
        const p = price();
        const costUsd = Number.isFinite(reported) ? reported : p ? (usage.input * p.input + usage.output * p.output) / 1_000_000 : null;
        return { text, usage, costUsd, model: body.model ?? use, offline: false };
      }
      last = `${res.status} ${body.error?.message ?? ""}`.trim();
      if (![408, 429, 500, 502, 503, 504].includes(res.status)) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw new Error(`OpenRouter (${use}): ${last}`);
  }
}

/** Offline stand-in. Returns empty text so each character uses its deterministic fallback. */
export class OfflineLLM implements LLM {
  readonly offline = true;
  readonly model = "offline";
  async complete(): Promise<Completion> {
    return { text: "", usage: { input: 0, output: 0 }, costUsd: 0, model: this.model, offline: true };
  }
}

export function makeLLM(): LLM {
  if (process.env.ROOM_OFFLINE === "1") return new OfflineLLM();
  const forced = process.env.LLM_PROVIDER;
  if (forced === "offline") return new OfflineLLM();
  if ((forced === "openrouter" || !forced) && process.env.OPENROUTER_API_KEY) return new OpenRouterLLM();
  if ((forced === "anthropic" || !forced) && process.env.ANTHROPIC_API_KEY) return new AnthropicLLM();
  return new OfflineLLM();
}

/** Pull the first JSON object out of a model reply (fenced or bare). */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}
