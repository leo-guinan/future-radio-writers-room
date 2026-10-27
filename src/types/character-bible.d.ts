declare module "future-radio-character-bible" {
  export interface BibleModel {
    name: string;
    character: string;
    inputsHash: string;
    identity: { intro: string; job: string; constraints: string; conflict: string };
    canon: { notes: string[]; viewerNotes: Array<{ file: string; from: string; experience: string; episode: string; note: string }> };
    voice: { settings: unknown; samples: Array<{ line: string; source: string; idea: string | null; at: string | null }> };
    record: { runs: number; firstSeen: string | null; lastSeen: string | null; ideas: Array<{ id: string; runs: number }>; episodes: Array<{ id: string; runs: number }>; patronsServed: number };
  }
  export function build(dir: string): { model: BibleModel; changed: string[] };
  export function render(dir: string): { model: BibleModel; files: Record<string, string> };
  export function stale(dir: string): string[];
  export function check(dir: string, opts?: { base?: string }): { ok: boolean; problems: string[]; notes: string[]; changed: Array<{ status: string; path: string }> };
  export function initGithub(dir: string, opts?: { pkg?: string; force?: boolean }): string[];
  export function propose(dir: string, opts: { note: string; from?: string; experience?: string; episode?: string; transcript?: Array<{ role: string; content: string }> }): string;
}
