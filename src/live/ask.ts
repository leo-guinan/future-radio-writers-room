// The cast's questions to the archive. Three questions are enough to riff on: who is this, what
// have they posted (to someone, about something), and what have they posted lately.
//   McpAsk      the Community Archive MCP (STATION_ARCHIVE_MCP_URL)
//   FixtureAsk  recorded answers keyed by the question (tests and demos)

import { readFileSync } from "node:fs";
import { McpArchive } from "../station/archive.ts";

export interface Found { id: string; user: string; name: string; text: string; created_at: string; url?: string; likes?: number; reply_to?: string | null }
export interface Account { username: string; name: string; location?: string; website?: string; created_at?: string; followers?: number }
export interface AskArchive {
  readonly id: string;
  account(user: string): Promise<Account | null>;
  search(q: string, opts?: { from_user?: string; since?: string; limit?: number }): Promise<Found[]>;
  recent(user: string, since: string): Promise<Found[]>;
}

const norm = (t: any): Found => ({ id: String(t.id ?? t.tweet_id), user: t.user ?? t.username, name: t.name ?? t.account_display_name, text: t.text ?? t.full_text, created_at: t.created_at, url: t.url, likes: t.likes ?? t.favorite_count, reply_to: t.reply_to?.id ?? t.reply_to_tweet_id ?? null });

export class McpAsk implements AskArchive {
  readonly id = "community-archive-mcp";
  private mcp = new McpArchive();
  async account(user: string) {
    const a = await this.mcp.tool("ca_account", { account: user }).catch(() => null);
    return a?.username ? { username: a.username, name: a.account_display_name, location: a.location, website: a.website, created_at: a.account_created_at, followers: a.num_followers } : null;
  }
  async search(q: string, o: { from_user?: string; since?: string; limit?: number } = {}) {
    const r = await this.mcp.tool("ca_search_tweets", { q, ...o, limit: o.limit ?? 30 });
    return (r.tweets ?? []).filter((t: any) => t.user).map(norm);
  }
  async recent(user: string, since: string) {
    const r = await this.mcp.tool("ca_account_tweets", { account: user, since, exclude_retweets: true, limit: 50 });
    return (r.tweets ?? []).map(norm);
  }
}

export const askKey = (tool: string, args: Record<string, unknown>) => `${tool}:${JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]))}`;

/** Recorded answers: { "<askKey>": result }. Unknown questions get an empty answer. */
export class FixtureAsk implements AskArchive {
  readonly id = "fixture";
  constructor(private answers: Record<string, any>) {}
  static fromFile(f: string) { return new FixtureAsk(JSON.parse(readFileSync(f, "utf8")).answers); }
  calls: string[] = [];
  private get(tool: string, args: Record<string, unknown>) { const k = askKey(tool, args); this.calls.push(k); return this.answers[k]; }
  async account(user: string) { return this.get("account", { user }) ?? null; }
  async search(q: string, o: { from_user?: string } = {}) { return (this.get("search", { q, from_user: o.from_user ?? null }) ?? []).map(norm); }
  async recent(user: string, _since: string) { return (this.get("recent", { user }) ?? []).map(norm); }
}
