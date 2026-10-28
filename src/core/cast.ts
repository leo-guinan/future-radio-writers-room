// Roles and the characters who play them.
//
// A role is a job the room needs done: memory, making, accounting (assembly is the showrunner,
// which has no persona). A character is who plays a role in this particular show. cast.json
// maps one to the other, so a room recasts a role by editing one line, not the code.
//
// cast.json also lists the principals: everyone with a dressing room of their own. The role
// characters always are; an extra joins them when promoted. cast.json is part of the room's
// repo, so a recasting or a promotion is a reviewable change.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROLES = ["memory", "making", "accounting"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_JOBS: Record<Role, string> = {
  memory: "remembers: retrieves what the record holds and cites it, never inventing history",
  making: "creates: turns an idea into approaches, each with a stopping rule and a cost estimate",
  accounting: "keeps the score: story, business and participation; observed apart from projected",
};

/** Future Radio's casting, used when cast.json doesn't say. */
export const DEFAULT_ROLES: Record<Role, string> = { memory: "borges", making: "leonardo", accounting: "agnolo" };

export interface CastFile {
  show: string;
  /** Who introduces transmissions and invites the audience in template cuts (any slug; needn't be a principal). */
  host: string | null;
  roles: Record<Role, string>;
  principals: string[];
  promotion: { appearances: number; viewerNotes: number; votes: number };
  /**
   * Which model each character runs on (OpenRouter ids, "vendor/model"). Keys are a character
   * slug, a role, "showrunner", or "default". Unlisted characters use ROOM_MODEL.
   */
  models: Record<string, string>;
}

const castPath = () => process.env.CAST_FILE ?? join(process.cwd(), "cast.json");
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function castFile(): CastFile {
  const p = castPath();
  const f = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Partial<CastFile>) : {};
  const roles = { ...DEFAULT_ROLES, ...(f.roles ?? {}) } as Record<Role, string>;
  for (const r of ROLES) if (!SLUG.test(roles[r])) throw new Error(`cast.json: role '${r}' needs a character slug (lowercase, digits, dashes), got '${roles[r]}'.`);
  if (new Set(ROLES.map((r) => roles[r])).size !== ROLES.length) throw new Error("cast.json: each role needs its own character.");
  return {
    show: typeof (f as any).show === "string" ? (f as any).show : "Future Radio",
    host: typeof (f as any).host === "string" ? (f as any).host : null,
    roles,
    principals: [...new Set([...ROLES.map((r) => roles[r]), ...(f.principals ?? [])])],
    promotion: { appearances: 2, viewerNotes: 3, votes: 5, ...(f.promotion ?? {}) },
    models: Object.fromEntries(Object.entries((f as any).models ?? {}).filter(([k, v]) => !k.startsWith("$") && typeof v === "string")) as Record<string, string>,
  };
}

/** The character who plays a role. */
export const playedBy = (role: Role) => castFile().roles[role];
/** The role a character plays, if any. */
export const roleOf = (slug: string): Role | undefined => ROLES.find((r) => castFile().roles[r] === slug);
/** The characters who play the room's roles, in pipeline order. */
export const roleCharacters = () => ROLES.map(playedBy);
/** A display name from a slug: "the-cat" → "The cat". */
export const displayName = (slug: string) => (slug[0]?.toUpperCase() ?? "") + slug.slice(1).replace(/-/g, " ");

/** The model a character (or the showrunner) runs on, from cast.json; undefined means the room's default. */
export function modelFor(slug: string): string | undefined {
  const m = castFile().models;
  const role = slug === "showrunner" ? "assembly" : roleOf(slug);
  return m[slug] ?? (role ? m[role] : undefined) ?? m.default;
}

/** Characters with a dressing room of their own. */
export const principals = () => castFile().principals;
export const isPrincipal = (slug: string) => principals().includes(slug);

export function addPrincipal(slug: string) {
  const p = castPath();
  const raw = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  raw.principals = [...new Set([...(raw.principals ?? roleCharacters()), slug])];
  writeFileSync(p, JSON.stringify(raw, null, 2) + "\n");
}
