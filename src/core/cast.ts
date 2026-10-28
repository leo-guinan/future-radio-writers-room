// Who has a dressing room of their own. The three agents always do; an extra joins them
// when promoted. cast.json is part of the room's repo, so a promotion is a reviewable change.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CastFile {
  principals: string[];
  promotion: { appearances: number; viewerNotes: number; votes: number };
}

const AGENTS = ["borges", "leonardo", "agnolo"];
const castPath = () => process.env.CAST_FILE ?? join(process.cwd(), "cast.json");

export function castFile(): CastFile {
  const p = castPath();
  const f = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Partial<CastFile>) : {};
  return {
    principals: [...new Set([...AGENTS, ...(f.principals ?? [])])],
    promotion: { appearances: 2, viewerNotes: 3, votes: 5, ...(f.promotion ?? {}) },
  };
}

/** Characters with a dressing room of their own. */
export const principals = () => castFile().principals;
export const isPrincipal = (slug: string) => principals().includes(slug);

export function addPrincipal(slug: string) {
  const p = castPath();
  const raw = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  raw.principals = [...new Set([...(raw.principals ?? AGENTS), slug])];
  writeFileSync(p, JSON.stringify(raw, null, 2) + "\n");
}
