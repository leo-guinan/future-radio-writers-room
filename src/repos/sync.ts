// Bring merged viewer pull requests into the room, and send the room's new history out.
//
// For each dressing room with a remote: fetch, rebase the room's local commits onto
// origin/main, rebuild the bible, push. Conflicts in bible/ are resolved by rebuilding
// (it's generated). Any other conflict stops that room's sync and is reported — nothing
// is forced.

import type { Room } from "../core/room.ts";
import { build as buildBible, characterFolders } from "future-radio-character-bible";
import { principals } from "../core/cast.ts";
import { dressingRoom } from "./dressing-room.ts";
import { extrasRepo } from "./extras.ts";
import type { Repo } from "./git.ts";

export interface SyncResult {
  character: string;
  repo: string;
  status: "no-remote" | "synced" | "conflict" | "error";
  pulled: string[]; // subjects of commits that came in
  newViewerNotes: string[];
  pushed: boolean;
  message?: string;
}

export function syncDressingRoom(c: string): SyncResult {
  const dr = dressingRoom(c).ensure();
  const repo = dr.repo;
  const base: SyncResult = { character: c, repo: repo.name, status: "no-remote", pulled: [], newViewerNotes: [], pushed: false };
  if (!repo.remote()) return base;
  try {
    repo.git(["fetch", "-q", "origin"]);
    const hasUpstream = repo.git(["rev-parse", "--verify", "-q", "origin/main"], true);
    if (hasUpstream) {
      const before = new Set(dr.bible().canon.viewerNotes.map((v) => v.file));
      base.pulled = repo.git(["log", "--format=%s", "HEAD..origin/main"], true).split("\n").filter(Boolean);
      // Resolve generated-file conflicts by rebuilding; give up on anything else.
      const conflict = rebaseRebuildingBibles(repo, () => buildBible(repo.dir));
      if (conflict) return { ...base, status: "conflict", message: `Conflict in ${conflict.join(", ")}; resolve it in ${repo.dir} and sync again.` };
      base.newViewerNotes = dr.bible().canon.viewerNotes.map((v) => v.file).filter((f) => !before.has(f));
    }
    dr.refresh(base.pulled.length ? `Rebuild ${c}'s bible after ${base.pulled.length} merged change(s)` : "Rebuild the character bible");
    repo.git(["push", "-q", "-u", "origin", "main"]);
    return { ...base, status: "synced", pushed: true };
  } catch (e: any) {
    return { ...base, status: "error", message: String(e.stderr || e.message).trim().split("\n").at(-1) };
  }
}

/** Rebase onto origin/main, rebuilding generated bible/ folders on conflict. False if anything else conflicts. */
function rebaseRebuildingBibles(repo: Repo, rebuild: () => void): string[] | null {
  repo.git(["rebase", "-q", "origin/main"], true);
  for (let guard = 0; guard < 50 && repo.git(["rev-parse", "-q", "--verify", "REBASE_HEAD"], true); guard++) {
    const conflicted = repo.git(["diff", "--name-only", "--diff-filter=U"], true).split("\n").filter(Boolean);
    const real = conflicted.filter((f) => !/(^|\/)bible\//.test(f));
    if (real.length) {
      repo.git(["rebase", "--abort"], true);
      return real;
    }
    repo.git(["checkout", "--theirs", "--", ...conflicted], true);
    rebuild();
    repo.git(["add", "-A"]);
    repo.git(["-c", "core.editor=true", "rebase", "--continue"], true);
  }
  return null;
}

/** The shared extras repo: one fetch, rebase and push for every extra's folder. */
export function syncExtras(): SyncResult {
  const x = extrasRepo();
  const repo = x.ensure().repo;
  const base: SyncResult = { character: "extras", repo: "extras", status: "no-remote", pulled: [], newViewerNotes: [], pushed: false };
  if (!repo.remote()) return base;
  const viewerNotes = () => x.list().flatMap((slug) => x.extra(slug).bible().canon.viewerNotes.map((v) => `${slug}/${v.file}`));
  const rebuild = () => characterFolders(repo.dir).forEach((d) => buildBible(d));
  try {
    repo.git(["fetch", "-q", "origin"]);
    if (repo.git(["rev-parse", "--verify", "-q", "origin/main"], true)) {
      const before = new Set(viewerNotes());
      base.pulled = repo.git(["log", "--format=%s", "HEAD..origin/main"], true).split("\n").filter(Boolean);
      const conflict = rebaseRebuildingBibles(repo, rebuild);
      if (conflict) return { ...base, status: "conflict", message: `Conflict in ${conflict.join(", ")}; resolve it in ${repo.dir} and sync again.` };
      base.newViewerNotes = viewerNotes().filter((f) => !before.has(f));
    }
    rebuild();
    x.reindex(base.pulled.length ? `Rebuild the extras after ${base.pulled.length} merged change(s)` : "Rebuild the extras' bibles");
    repo.git(["push", "-q", "-u", "origin", "main"]);
    return { ...base, status: "synced", pushed: true };
  } catch (e: any) {
    return { ...base, status: "error", message: String(e.stderr || e.message).trim().split("\n").at(-1) };
  }
}

/** Sync every dressing room and the extras, and record what came in on the room's log. */
export function syncAll(room: Room): SyncResult[] {
  const results = [...principals().map(syncDressingRoom), syncExtras()];
  for (const r of results) {
    if (r.status !== "synced" || (!r.pulled.length && !r.newViewerNotes.length)) continue;
    room.store.append(
      "repo.commit",
      "system",
      {
        repo: r.repo,
        sha: r.repo === "extras" ? extrasRepo().repo.head() : dressingRoom(r.character).repo.head(),
        message: `Synced ${r.pulled.length} change(s) from GitHub${r.newViewerNotes.length ? `, ${r.newViewerNotes.length} new viewer note(s)` : ""}`,
        files: r.newViewerNotes,
      },
      "public",
    );
  }
  return results;
}
