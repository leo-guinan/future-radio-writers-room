// Where posts come from. The station asks one question per rule ("anything new since T?") and
// re-checks every answer with matches(), so a backend only has to narrow, never decide.
//
//   mcp      the Community Archive MCP (Streamable HTTP, JSON-RPC): STATION_ARCHIVE_MCP_URL,
//            optional STATION_ARCHIVE_MCP_TOKEN. Uses ca_account_tweets and ca_search_tweets.
//   fixture  a JSON file of posts, each with an optional "release_at" (demo and tests).

import { readFileSync } from "node:fs";
import type { Rule, Tweet } from "./rules.ts";

export interface Archive { readonly id: string; since(rule: Rule, sinceIso: string): Promise<Tweet[]> }

export class FixtureArchive implements Archive {
  readonly id = "fixture";
  constructor(private posts: Array<Tweet & { release_at?: string }>, private clock = () => Date.now()) {}
  static fromFile(f: string, clock?: () => number) {
    return new FixtureArchive(JSON.parse(readFileSync(f, "utf8")), clock);
  }
  async since(_rule: Rule, sinceIso: string) {
    const now = this.clock();
    const s = Date.parse(sinceIso);
    // A fixture post "arrives" at release_at: it is presented as created then, with the real
    // posting time kept in posted_at for the bulletin to read out.
    return this.posts
      .filter((p) => {
        const at = Date.parse(p.release_at ?? p.created_at);
        return at > s && at <= now;
      })
      .map((p) => (p.release_at ? { ...p, posted_at: p.created_at, created_at: p.release_at } : p));
  }
}

export class McpArchive implements Archive {
  readonly id = "community-archive-mcp";
  private session: string | null = null;
  private n = 0;
  constructor(private url = process.env.STATION_ARCHIVE_MCP_URL ?? "", private token = process.env.STATION_ARCHIVE_MCP_TOKEN ?? "") {
    if (!url) throw new Error("STATION_ARCHIVE_MCP_URL is not set");
  }
  private async rpc(method: string, params: unknown) {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.session) headers["mcp-session-id"] = this.session;
    const r = await fetch(this.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.n, method, params }) });
    if (!r.ok) throw new Error(`archive MCP ${method}: HTTP ${r.status}`);
    this.session = r.headers.get("mcp-session-id") ?? this.session;
    const raw = await r.text();
    const json = r.headers.get("content-type")?.includes("event-stream")
      ? JSON.parse(raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop() ?? "{}")
      : JSON.parse(raw || "{}");
    if (json.error) throw new Error(`archive MCP ${method}: ${json.error.message}`);
    return json.result;
  }
  private async call(name: string, args: Record<string, unknown>) {
    if (!this.session) {
      await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "future-radio-station", version: "0.1.0" } });
      await fetch(this.url, { method: "POST", headers: { "content-type": "application/json", ...(this.session ? { "mcp-session-id": this.session } : {}), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).catch(() => {});
    }
    const res = await this.rpc("tools/call", { name, arguments: args });
    const text = res?.content?.find((c: any) => c.type === "text")?.text ?? "{}";
    return JSON.parse(text);
  }
  async since(rule: Rule, sinceIso: string): Promise<Tweet[]> {
    const v = rule.value.replace(/^@/, "");
    const r =
      rule.kind === "from"
        ? await this.call("ca_account_tweets", { account: v, since: sinceIso, exclude_retweets: true, order: "asc", limit: 50 })
        : rule.kind === "reply"
          ? await this.call("ca_search_tweets", { q: v, reply_to_user: v, since: sinceIso, limit: 50 })
          : rule.kind === "mention"
            ? await this.call("ca_search_tweets", { q: v, since: sinceIso, limit: 50 })
            : await this.call("ca_search_tweets", { q: `"${v}"`, since: sinceIso, limit: 50 });
    return (r.tweets ?? []).filter((t: any) => t.user).map((t: any) => ({ ...t, reply_to_user: t.reply_to_user ?? (rule.kind === "reply" ? v : null) }));
  }
}

export function makeArchive(): Archive {
  if (process.env.STATION_ARCHIVE_FIXTURE) return FixtureArchive.fromFile(process.env.STATION_ARCHIVE_FIXTURE);
  return new McpArchive();
}
