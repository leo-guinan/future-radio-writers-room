// Every repo the room opens carries the room's licence (CC0 1.0 for Future Radio).
// The text comes from the room's own LICENSE file, so a room with another licence passes it on.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function licenseText(): string | null {
  const path = process.env.LICENSE_FILE ?? join(process.cwd(), "LICENSE");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Write LICENSE into a repo that doesn't have one yet. Returns true if it wrote it. */
export function ensureLicense(repo: { has(rel: string): boolean; write(rel: string, content: string): void }): boolean {
  const text = licenseText();
  if (!text || repo.has("LICENSE")) return false;
  repo.write("LICENSE", text);
  return true;
}
