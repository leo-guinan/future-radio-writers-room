// A small, synchronous git wrapper. Each repo is a plain git repository on disk;
// publishing to GitHub is a separate, explicit step (see publish.ts).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REPOS_DIR = () => process.env.REPOS_DIR ?? join(process.cwd(), "repos");
const AUTHOR_NAME = () => process.env.ROOM_GIT_NAME ?? "Future Radio Room";
const AUTHOR_EMAIL = () => process.env.ROOM_GIT_EMAIL ?? "room@future.radio";

export class Repo {
  constructor(readonly name: string, readonly dir = join(REPOS_DIR(), name)) {}

  get exists() {
    return existsSync(join(this.dir, ".git"));
  }

  git(args: string[], allowFail = false): string {
    try {
      return execFileSync("git", ["-C", this.dir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: AUTHOR_NAME(),
          GIT_AUTHOR_EMAIL: AUTHOR_EMAIL(),
          GIT_COMMITTER_NAME: AUTHOR_NAME(),
          GIT_COMMITTER_EMAIL: AUTHOR_EMAIL(),
        },
      }).trim();
    } catch (e) {
      if (allowFail) return "";
      throw e;
    }
  }

  init(): this {
    if (this.exists) return this;
    mkdirSync(this.dir, { recursive: true });
    this.git(["init", "-q", "-b", "main"]);
    return this;
  }

  path(rel: string) {
    return join(this.dir, rel);
  }

  has(rel: string) {
    return existsSync(this.path(rel));
  }

  read(rel: string): string {
    return readFileSync(this.path(rel), "utf8");
  }

  write(rel: string, content: string) {
    const p = this.path(rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }

  append(rel: string, line: string) {
    const p = this.path(rel);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, line);
  }

  /** Commit everything staged or not. Returns the new sha, or the current head if nothing changed. */
  commit(message: string): string {
    this.git(["add", "-A"]);
    const dirty = this.git(["status", "--porcelain"]);
    if (dirty) this.git(["commit", "-q", "-m", message]);
    return this.head();
  }

  /** Fold current changes into the last commit (used so a generated file can describe its own commit). */
  amend(): string {
    this.git(["add", "-A"]);
    if (this.git(["status", "--porcelain"])) this.git(["commit", "-q", "--amend", "--no-edit"]);
    return this.head();
  }

  /** An annotated tag marks a release in the repo's own history. Existing tags are left alone. */
  tag(name: string, message: string): boolean {
    if (this.git(["tag", "-l", name], true)) return false;
    this.git(["tag", "-a", name, "-m", message]);
    return true;
  }

  head(): string {
    return this.git(["rev-parse", "HEAD"], true);
  }

  log(n = 20): Array<{ sha: string; at: string; message: string }> {
    const raw = this.git(["log", `-n${n}`, "--format=%H%x09%cI%x09%s"], true);
    return raw
      ? raw.split("\n").map((l) => {
          const [sha, at, message] = l.split("\t");
          return { sha, at, message };
        })
      : [];
  }

  /** Read a file exactly as it was at a commit. */
  showAt(sha: string, rel: string): string {
    return this.git(["show", `${sha}:./${rel}`]); // ./ resolves against this folder, so it works for SubRepo too
  }

  remote(): string {
    return this.git(["remote", "get-url", "origin"], true);
  }
}

/**
 * A folder inside another repo, used like a repo of its own: reads and writes are
 * relative to the folder, commits go to the repo that holds it.
 */
export class SubRepo extends Repo {
  constructor(name: string, dir: string, readonly root: Repo) {
    super(name, dir);
  }
  override get exists() {
    return this.root.exists && existsSync(this.dir);
  }
  override init(): this {
    if (!this.root.exists) throw new Error(`${this.root.name} is not set up yet.`);
    mkdirSync(this.dir, { recursive: true });
    return this;
  }
  override remote(): string {
    return this.root.remote();
  }
}
