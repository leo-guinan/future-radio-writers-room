// The restricted workspace. Approved plans execute here: a disposable directory
// with an allowlist of file operations and no shell, no network, no environment,
// no credentials, and no deploy or publish path.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { sha256 } from "../core/events.ts";

export const WORKSPACE_ROOT = () => join(process.env.DATA_DIR ?? join(process.cwd(), "data"), "humain", "workspaces");

// Paths that are never readable or writable from inside a workspace.
const DENIED = ["../", ".env", "credentials", "secrets", ".ssh", ".git", "events.jsonl", ".npmrc", "token"];

export class WorkspaceDenied extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class RestrictedWorkspace {
  readonly dir: string;

  private constructor(readonly sessionId: string, dir: string) {
    this.dir = dir;
  }

  static create(sessionId: string): RestrictedWorkspace {
    if (!/^H-\d{4}$/.test(sessionId)) throw new WorkspaceDenied("Bad session id.");
    const dir = join(WORKSPACE_ROOT(), sessionId);
    rmSync(dir, { recursive: true, force: true }); // disposable: every run starts clean
    mkdirSync(dir, { recursive: true });
    return new RestrictedWorkspace(sessionId, dir);
  }

  static open(sessionId: string): RestrictedWorkspace {
    if (!/^H-\d{4}$/.test(sessionId)) throw new WorkspaceDenied("Bad session id.");
    const dir = join(WORKSPACE_ROOT(), sessionId);
    if (!existsSync(dir)) throw new WorkspaceDenied(`No workspace for ${sessionId}.`);
    return new RestrictedWorkspace(sessionId, dir);
  }

  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  private resolve(rel: string): string {
    const clean = normalize(rel).replace(/\\/g, "/");
    if (clean.startsWith("/") || clean.startsWith("..") || clean.includes("//"))
      throw new WorkspaceDenied(`Path escapes the workspace: ${rel}`);
    const lower = clean.toLowerCase();
    for (const d of DENIED) if (lower.includes(d)) throw new WorkspaceDenied(`Forbidden path: ${rel}`);
    const abs = join(this.dir, clean);
    if (relative(this.dir, abs).startsWith("..") || !abs.startsWith(this.dir + sep) || abs === this.dir)
      throw new WorkspaceDenied(`Path escapes the workspace: ${rel}`);
    return abs;
  }

  /** Allowlisted op: write a text file inside the workspace. No shell, no symlinks. */
  writeFile(rel: string, content: string, maxBytes = 512_000): { bytes: number; sha256: string } {
    if (Buffer.byteLength(content) > maxBytes) throw new WorkspaceDenied(`File too large: ${rel}`);
    const abs = this.resolve(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    const bytes = readFileSync(abs);
    return { bytes: bytes.length, sha256: sha256(bytes) };
  }

  /** Allowlisted op: read a text file inside the workspace. */
  readFile(rel: string): string {
    const abs = this.resolve(rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new WorkspaceDenied(`No file: ${rel}`);
    return readFileSync(abs, "utf8");
  }

  exists(rel: string): boolean {
    try {
      return existsSync(this.resolve(rel));
    } catch {
      return false;
    }
  }

  /** Allowlisted op: list files inside the workspace. */
  list(rel = "."): string[] {
    const abs = rel === "." ? this.dir : this.resolve(rel);
    if (!existsSync(abs)) return [];
    const out: string[] = [];
    const walk = (d: string, prefix: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const rp = prefix ? `${prefix}/${name}` : name;
        if (statSync(p).isDirectory()) walk(p, rp);
        else out.push(rp);
      }
    };
    walk(abs, rel === "." ? "" : rel);
    return out.sort();
  }
}

// There is intentionally no shell, fetch, env access, or publish/deploy helper
// in this module. Anything unlisted above cannot run inside the workspace.
