// Bring merged viewer pull requests into the room, and send the room's new history out.
//
// For each dressing room with a remote: fetch, rebase the room's local commits onto
// origin/main, rebuild the bible, push. Conflicts in bible/ are resolved by rebuilding
// (it's generated). Any other conflict stops that room's sync and is reported — nothing
// is forced.

import type { Room } from "../core/room.ts";
import { CAST, type Character } from "../core/types.ts";
import { build as buildBible } from "future-radio-character-bible";
import { dressingRoom } from "./dressing-room.ts";

export interface SyncResult {
  character: Character;
  repo: string;
  status: "no-remote" | "synced" | "conflict" | "error";
  pulled: string[]; // subjects of commits that came in
  newViewerNotes: string[];
  pushed: boolean;
  message?: string;
}

export function syncDressingRoom(c: Character): SyncResult {
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
      const rebased = repo.git(["rebase", "-q", "origin/main"], true);
      void rebased;
      // Resolve generated-file conflicts by rebuilding; give up on anything else.
      for (let guard = 0; guard < 50 && repo.git(["rev-parse", "-q", "--verify", "REBASE_HEAD"], true); guard++) {
        const conflicted = repo.git(["diff", "--name-only", "--diff-filter=U"], true).split("\n").filter(Boolean);
        if (conflicted.some((f) => !f.startsWith("bible/"))) {
          repo.git(["rebase", "--abort"], true);
          return { ...base, status: "conflict", message: `Conflict in ${conflicted.filter((f) => !f.startsWith("bible/")).join(", ")}; resolve it in ${repo.dir} and sync again.` };
        }
        repo.git(["checkout", "--theirs", "--", "bible"], true);
        buildBible(repo.dir);
        repo.git(["add", "bible"]);
        repo.git(["-c", "core.editor=true", "rebase", "--continue"], true);
      }
      base.newViewerNotes = dr.bible().canon.viewerNotes.map((v) => v.file).filter((f) => !before.has(f));
    }
    dr.refresh(base.pulled.length ? `Rebuild ${c}'s bible after ${base.pulled.length} merged change(s)` : "Rebuild the character bible");
    repo.git(["push", "-q", "-u", "origin", "main"]);
    return { ...base, status: "synced", pushed: true };
  } catch (e: any) {
    return { ...base, status: "error", message: String(e.stderr || e.message).trim().split("\n").at(-1) };
  }
}

/** Sync every dressing room and record what came in on the room's log. */
export function syncAll(room: Room): SyncResult[] {
  const results = CAST.map(syncDressingRoom);
  for (const r of results) {
    if (r.status !== "synced" || (!r.pulled.length && !r.newViewerNotes.length)) continue;
    room.store.append(
      "repo.commit",
      "system",
      {
        repo: r.repo,
        sha: dressingRoom(r.character).repo.head(),
        message: `Synced ${r.pulled.length} change(s) from GitHub${r.newViewerNotes.length ? `, ${r.newViewerNotes.length} new viewer note(s)` : ""}`,
        files: r.newViewerNotes,
      },
      "public",
    );
  }
  return results;
}
