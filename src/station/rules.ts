// Trigger rules: what in the Community Archive makes the cast react. Rules are data, kept in
// DATA_DIR/station/rules.json, changed only through programming contracts (see program.ts).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./schedule.ts";

export type RuleKind = "from" | "mention" | "reply" | "keyword";
export interface Rule { id: string; kind: RuleKind; value: string; cooldown_min: number; enabled: boolean; added_at: string; source: string }
export interface Tweet { id: string; url: string; user: string; name: string; created_at: string; text: string; reply_to_user?: string | null; posted_at?: string }

export const DATA = () => join(process.env.DATA_DIR ?? join(ROOT, "data"), "station");
export const ROOT_ALIASES = () => ROOT;
export const OWNER = () => (process.env.STATION_OWNER ?? "leo_guinan").replace(/^@/, "");

export function loadRules(): Rule[] {
  const f = join(DATA(), "rules.json");
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const seed = join(ROOT, "station/rules.seed.json");
  return existsSync(seed) ? JSON.parse(readFileSync(seed, "utf8")) : [];
}
export function saveRules(rules: Rule[]) {
  const f = join(DATA(), "rules.json");
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(rules, null, 1));
}
export function nextRuleId(rules: Rule[]) {
  const n = rules.reduce((m, r) => Math.max(m, Number(r.id.slice(2)) || 0), 0) + 1;
  return `R-${String(n).padStart(4, "0")}`;
}

const norm = (s: string) => s.toLowerCase().replace(/^@/, "");
const handles = (text: string) => [...text.matchAll(/@([A-Za-z0-9_]{1,15})/g)].map((m) => norm(m[1]));

/** Does this rule fire on this post? Pure; the archive query only narrows the candidates. */
export function matches(rule: Rule, t: Tweet): boolean {
  if (!rule.enabled) return false;
  const v = norm(rule.value);
  const author = norm(t.user ?? "");
  switch (rule.kind) {
    case "from":
      return author === v && !t.text.startsWith("RT @");
    case "mention":
      return author !== v && handles(t.text).includes(v);
    case "reply":
      return author !== v && (norm(t.reply_to_user ?? "") === v || handles(t.text.trimStart().match(/^(@\w{1,15}\s+)+/)?.[0] ?? "").includes(v));
    case "keyword": {
      const words = v.split(/\s+/).filter(Boolean);
      const hay = t.text.toLowerCase();
      return words.length > 0 && hay.includes(words.join(" "));
    }
  }
}
