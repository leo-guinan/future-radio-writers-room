// Thin model client. Every call returns usage so Agnolo can account for it.
// With no ANTHROPIC_API_KEY the room runs offline: characters fall back to
// deterministic behaviour, and the run is recorded as offline at $0.

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
  complete(args: { system: string; user: string; maxTokens?: number }): Promise<Completion>;
}

function price(): { input: number; output: number } | null {
  const i = Number(process.env.PRICE_INPUT_PER_MTOK);
  const o = Number(process.env.PRICE_OUTPUT_PER_MTOK);
  return Number.isFinite(i) && Number.isFinite(o) && i > 0 && o > 0 ? { input: i, output: o } : null;
}

export class AnthropicLLM implements LLM {
  readonly offline = false;
  private client: Anthropic;
  constructor(readonly model = process.env.ROOM_MODEL ?? "claude-sonnet-5-5") {
    this.client = new Anthropic();
  }
  async complete({ system, user, maxTokens = 1500 }: { system: string; user: string; maxTokens?: number }): Promise<Completion> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
    const usage = { input: res.usage.input_tokens, output: res.usage.output_tokens };
    const p = price();
    const costUsd = p ? (usage.input * p.input + usage.output * p.output) / 1_000_000 : null;
    return { text, usage, costUsd, model: this.model, offline: false };
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
  return process.env.ANTHROPIC_API_KEY && process.env.ROOM_OFFLINE !== "1" ? new AnthropicLLM() : new OfflineLLM();
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
