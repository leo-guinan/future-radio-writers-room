// The rules that let reactions air without review. Enforced in code, before anything is voiced.
// A post that fails any check is logged as skipped (with the reason) and never aired.

import type { Rule, Tweet } from "./rules.ts";

// Personal threads stay out: grief, illness, violence, self-harm, and anything sexual.
const SENSITIVE = /\b(kill(ed|ing|s)?|suicid\w*|self[- ]?harm|rape\w*|murder\w*|shoot\w*|died|death|dying|funeral|passed away|cancer|chemo|hospital\w*|diagnos\w*|overdos\w*|abuse\w*|assault\w*|porn\w*|nsfw|nude\w*|sex\w*)\b/i;
const URL_ONLY = /^\s*(https?:\/\/\S+\s*)+$/;

export interface Limits { perAccountPerDay: number; perDay: number; minChars: number; maxChars: number; deny: string[] }
export const limits = (): Limits => ({
  perAccountPerDay: Number(process.env.STATION_PER_ACCOUNT_PER_DAY ?? 3),
  perDay: Number(process.env.STATION_PER_DAY ?? 24),
  minChars: 12,
  maxChars: 600,
  deny: (process.env.STATION_DENY ?? "").split(",").map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean),
});

export interface Aired { t: number; user: string; rule: string }

/** null = may air; otherwise the reason it may not. */
export function vet(tw: Tweet, rule: Rule, aired: Aired[], now: number, L = limits()): string | null {
  const text = tw.text ?? "";
  const user = (tw.user ?? "").toLowerCase();
  if (!user) return "no author";
  if (L.deny.includes(user)) return "author on the deny list";
  if (text.startsWith("RT @")) return "retweet";
  if (URL_ONLY.test(text)) return "link only";
  const bare = text.replace(/https?:\/\/\S+/g, "").replace(/(^|\s)@\w+/g, " ").trim();
  if (bare.length < L.minChars) return "too short to read aloud";
  if (text.length > L.maxChars) return "too long for a bulletin";
  if (SENSITIVE.test(text)) return "sensitive topic: personal threads stay out";
  const day = aired.filter((a) => now - a.t < 86400);
  if (day.length >= L.perDay) return "daily bulletin limit reached";
  if (day.filter((a) => a.user === user).length >= L.perAccountPerDay) return "per-account daily limit reached";
  const last = aired.filter((a) => a.rule === rule.id).at(-1);
  if (last && now - last.t < rule.cooldown_min * 60) return `rule cooling down (${rule.cooldown_min} min)`;
  return null;
}
