declare module "future-radio-character-bible" {
  export interface BibleModel {
    name: string;
    character: string;
    inputsHash: string;
    identity: { intro: string; job: string; constraints: string; conflict: string };
    canon: { notes: string[]; viewerNotes: Array<{ file: string; from: string; experience: string; episode: string; note: string }> };
    voice: { settings: unknown; samples: Array<{ line: string; source: string; idea: string | null; episode: string | null; at: string | null }> };
    record: { runs: number; firstSeen: string | null; lastSeen: string | null; ideas: Array<{ id: string; runs: number }>; episodes: Array<{ id: string; runs: number }>; patronsServed: number; appearances: Array<{ id: string; episode: string | null; at: string | null; file: string }> };
  }
  export function build(dir: string): { model: BibleModel; changed: string[] };
  export function render(dir: string): { model: BibleModel; files: Record<string, string> };
  export function stale(dir: string): string[];
  export function check(dir: string, opts?: { base?: string }): { ok: boolean; problems: string[]; notes: string[]; changed: Array<{ status: string; path: string }> };
  export function load(dir: string): { name: string; slug: string };
  export function initGithub(dir: string, opts?: { pkg?: string; force?: boolean }): string[];
  export function initExtrasGithub(root: string, opts?: { pkg?: string; force?: boolean }): string[];
  export function characterFolders(dir: string): string[];
  export function propose(dir: string, opts: { note: string; from?: string; experience?: string; episode?: string; transcript?: Array<{ role: string; content: string }> }): string;
}
