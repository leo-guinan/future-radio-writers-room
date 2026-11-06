// Watching one thread. A source returns a snapshot (counts + the replies and quotes it can see);
// diff() turns consecutive snapshots into typed updates. Count changes are coalesced per poll
// ("3 new likes"), views are announced at milestones, replies and quotes one by one.
//
//   x         X API v2 (X_BEARER_TOKEN): live counts incl. views and bookmarks, replies via
//             conversation_id search, quote posts. Needs a paid API tier.
//   archive   the Community Archive MCP: free, but only what the archive has observed, and late.
//   push      nothing polled: updates arrive by POST /api/live/update (an agent, a bookmarklet, you).
//   fixture   a JSON timeline of snapshots (tests and demos).

import { readFileSync } from "node:fs";
import { McpArchive } from "../station/archive.ts";
import type { Update, UpdateType } from "./types.ts";

export interface Post { id: string; user: string; name: string; text: string; url: string; created_at: string }
export interface Snapshot { likes: number; reposts: number; bookmarks?: number; views?: number; replies: Post[]; quotes: Post[] }
export interface ThreadSource { readonly id: string; snapshot(): Promise<Snapshot | null>; root?(): Promise<string> }

export const VIEW_MILESTONES = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];

export function diff(prev: Snapshot | null, next: Snapshot, now = new Date().toISOString()): Update[] {
  if (!prev) return []; // the first look sets the baseline; it is not news
  const out: Update[] = [];
  const seen = new Set([...prev.replies, ...prev.quotes].map((p) => p.id));
  const post = (type: UpdateType, p: Post): Update => ({ id: `${type}:${p.id}`, type, at: now, user: p.user, name: p.name, text: p.text, url: p.url });
  for (const p of next.replies) if (!seen.has(p.id)) out.push(post("reply", p));
  for (const p of next.quotes) if (!seen.has(p.id)) out.push(post("quote", p));
  const count = (type: UpdateType, a = 0, b = 0) => {
    if (b > a) out.push({ id: `${type}:${b}:${now}`, type, at: now, count: b - a });
  };
  count("repost", prev.reposts, next.reposts);
  count("like", prev.likes, next.likes);
  count("bookmark", prev.bookmarks, next.bookmarks);
  const passed = VIEW_MILESTONES.filter((m) => (prev.views ?? 0) < m && (next.views ?? 0) >= m).at(-1);
  if (passed) out.push({ id: `views:${passed}`, type: "views", at: now, count: passed });
  return out;
}

export class XApiThread implements ThreadSource {
  readonly id = "x-api";
  constructor(private tweet: string, private token = process.env.X_BEARER_TOKEN ?? "") {
    if (!token) throw new Error("X_BEARER_TOKEN is not set");
  }
  private async get(path: string) {
    const r = await fetch(`https://api.x.com/2/${path}`, { headers: { authorization: `Bearer ${this.token}` } });
    if (!r.ok) throw new Error(`X API ${path.split("?")[0]}: HTTP ${r.status}`);
    return r.json() as Promise<any>;
  }
  private posts(body: any): Post[] {
    const users = new Map((body.includes?.users ?? []).map((u: any) => [u.id, u]));
    return (body.data ?? []).map((t: any) => {
      const u: any = users.get(t.author_id) ?? {};
      return { id: t.id, user: u.username ?? "", name: u.name ?? "", text: t.text, url: `https://x.com/${u.username}/status/${t.id}`, created_at: t.created_at };
    });
  }
  async root() {
    return String((await this.get(`tweets/${this.tweet}?tweet.fields=note_tweet`)).data?.note_tweet?.text ?? "");
  }
  async snapshot(): Promise<Snapshot> {
    const fields = "tweet.fields=public_metrics,created_at,author_id,conversation_id&expansions=author_id&user.fields=username,name";
    const root = await this.get(`tweets/${this.tweet}?tweet.fields=public_metrics`);
    const m = root.data?.public_metrics ?? {};
    const replies = await this.get(`tweets/search/recent?query=${encodeURIComponent(`conversation_id:${this.tweet}`)}&max_results=100&${fields}`).catch(() => ({ data: [] }));
    const quotes = await this.get(`tweets/${this.tweet}/quote_tweets?max_results=100&${fields}`).catch(() => ({ data: [] }));
    return { likes: m.like_count ?? 0, reposts: m.retweet_count ?? 0, bookmarks: m.bookmark_count, views: m.impression_count, replies: this.posts(replies), quotes: this.posts(quotes) };
  }
}

export class ArchiveThread implements ThreadSource {
  readonly id = "community-archive";
  private mcp = new McpArchive();
  constructor(private tweet: string) {}
  async root() {
    const r = await this.mcp.tool("ca_get_tweets", { refs: [this.tweet], format: "full" });
    return String(r.tweets?.[0]?.full_text ?? "");
  }
  async snapshot(): Promise<Snapshot | null> {
    const r = await this.mcp.tool("ca_get_tweets", { refs: [this.tweet], format: "full" });
    const t = r.tweets?.[0];
    if (!t) return null;
    // Replies and quotes the archive has observed: posts mentioning the author since the thread began.
    const day = String(t.created_at).slice(0, 10);
    const s = await this.mcp.tool("ca_search_tweets", { q: t.username, since: day, limit: 50, format: "full" });
    // The author's own replies don't mention their handle, so the search misses them: add their timeline.
    const own = await this.mcp.tool("ca_account_tweets", { account: t.username, since: day, limit: 200, format: "full" }).catch(() => ({ tweets: [] }));
    const byId = new Map<string, any>([...(s.tweets ?? []), ...(own.tweets ?? [])].map((x: any) => [String(x.tweet_id), x]));
    const all: any[] = [...byId.values()];
    const toPost = (x: any): Post => ({ id: x.tweet_id, user: x.username, name: x.account_display_name, text: x.full_text, url: `https://x.com/${x.username}/status/${x.tweet_id}`, created_at: x.created_at });
    return {
      likes: t.favorite_count ?? 0,
      reposts: t.retweet_count ?? 0,
      replies: all.filter((x) => (x.conversation_id === this.tweet || x.reply_to_tweet_id === this.tweet) && x.tweet_id !== this.tweet).map(toPost),
      quotes: all.filter((x) => x.quoted_tweet_id === this.tweet).map(toPost),
    };
  }
}

export class PushThread implements ThreadSource {
  readonly id = "push";
  async snapshot() { return null; }
}

/** A timeline of snapshots, each released at `at_secs` after the run starts. */
export class FixtureThread implements ThreadSource {
  readonly id = "fixture";
  constructor(private steps: Array<{ at_secs: number; snapshot: Snapshot }>, private startedAt: () => number, private clock = () => Date.now(), private rootText = "") {}
  static fromFile(f: string, startedAt: () => number, clock?: () => number) {
    const j = JSON.parse(readFileSync(f, "utf8"));
    return new FixtureThread(j.steps, startedAt, clock, j.root_text ?? "");
  }
  async root() { return this.rootText; }
  async snapshot() {
    const t = (this.clock() - this.startedAt()) / 1000;
    return this.steps.filter((s) => s.at_secs <= t).at(-1)?.snapshot ?? null;
  }
}
