// The riff: the cast ask the archive questions about whoever just engaged, one turn at a time,
// for as long as the answers are interesting.
//
// Interesting is measured, not judged: an answer counts when it brings a record nobody has cited
// yet AND that record shares words with the update (or with the sentence of the thread that names
// the person), or when it is the first answer of its kind ("who is this?"). Two dull answers in a
// row and Mrs. Bus wraps the segment. Every quoted post passes the same safety check as bulletins.

import { speakable } from "../station/react.ts";
import { vet } from "../station/safety.ts";
import type { AskArchive, Found } from "./ask.ts";
import type { Line, Update } from "./types.ts";

const STOP = new Set("about after again against because before being between could doesn't every first itself might other should since still their there these thing think those through under until where which while would people really there's thanks".split(" "));
export const keywords = (t: string) => new Set((t.toLowerCase().replace(/https?:\/\/\S+/g, "").match(/[a-z][a-z'-]{4,}|\d{4}/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.replace(/(ies|es|s|ing|ed)$/, "")));
const overlap = (a: Set<string>, t: string) => [...keywords(t)].filter((w) => a.has(w)).length;
const date = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const unquote = (s: string) => s.replace(/^["“]+|["”]+$/g, "").trim();
const words = (s: string, n: number) => { const w = s.split(/\s+/); return w.length > n ? w.slice(0, n).join(" ") + "…" : s; };
const substantive = (t: Found) => !t.text.startsWith("RT @") && t.text.replace(/https?:\/\/\S+/g, "").replace(/(^|\s)@\w+/g, " ").trim().length >= 20;
const safe = (t: Found) => !vet({ ...t, url: t.url ?? "", reply_to_user: null }, { id: "riff", kind: "from", value: "", cooldown_min: 0, enabled: true, added_at: "", source: "" }, [], Date.now() / 1000, { perAccountPerDay: 99, perDay: 999, minChars: 1, maxChars: 4000, deny: (process.env.STATION_DENY ?? "").split(",").filter(Boolean) });

type Q = { asker: Line["speaker"]; question: string; kind: string; run: () => Promise<{ text: string; post?: Found; novel: boolean; found: number; cite?: string; tool: string; args: Record<string, unknown> }> };

export class Riff {
  readonly cited = new Set<string>();
  readonly seenKinds = new Set<string>();
  turns = 0;
  stale = 0;
  asked = 0;
  answered = 0;
  done = false;
  private plan: Q[];
  private i = 0;
  private interest: Set<string>;

  constructor(private u: Update, private ask: AskArchive, private owner: string, focus: string, private staleLimit = 2) {
    this.interest = new Set([...keywords(u.text ?? ""), ...keywords(focus)]);
    for (const w of [u.user, owner].filter(Boolean)) this.interest.delete(w!.toLowerCase());
    this.plan = u.user ? this.personPlan(u.user, u.name || u.user) : [];
  }

  /** Pick the most relevant uncited, substantive, safe post; relevance decides whether it is news. */
  private pick(posts: Found[]) {
    const fresh = posts.filter((p) => !this.cited.has(p.id) && substantive(p) && safe(p));
    const scored = fresh.map((p) => ({ p, s: overlap(this.interest, p.text) })).sort((a, b) => b.s - a.s || a.p.created_at.localeCompare(b.p.created_at));
    return { best: scored[0]?.p, relevant: (scored[0]?.s ?? 0) > 0, total: posts.length };
  }

  private personPlan(user: string, name: string): Q[] {
    const owner = this.owner;
    const who: Q = {
      asker: "LEONARDO", kind: "who", question: `Wait. Who is ${name}?`,
      run: async () => {
        const a = await this.ask.account(user);
        if (!a) return { text: `The library has no card for ${name}.`, novel: false, found: 0, tool: "ca_account", args: { account: user } };
        const bits = [a.location && `Based in ${a.location}`, a.website && `website ${a.website.replace(/^https?:\/\/(www\.)?/, "")}`, a.created_at && `on X since ${new Date(a.created_at).getFullYear()}`, a.followers && `${a.followers.toLocaleString("en-US")} followers`].filter(Boolean);
        return { text: `${a.name}. ${bits.join(", ")}.`, novel: true, found: 1, cite: `acct:${user}`, tool: "ca_account", args: { account: user } };
      },
    };
    const between = (from: string, to: string, label: (p: Found) => string, asker: Line["speaker"], question: string, kind: string): Q => ({
      asker, kind, question,
      run: async () => {
        const posts = await this.ask.search(to, { from_user: from });
        const { best, relevant, total } = this.pick(posts);
        const args = { q: to, from_user: from };
        if (!best) return { text: total ? "Nothing new there." : "The archive has nothing on that.", novel: false, found: total, tool: "ca_search_tweets", args };
        const first = !this.seenKinds.has(kind);
        return { text: `${label(best)}, ${date(best.created_at)}: "${words(unquote(speakable(best.text)), 34)}"`, post: best, novel: relevant || first, found: total, cite: best.id, tool: "ca_search_tweets", args };
      },
    });
    const fromThem = (q: string) => between(user, owner, () => `${name} to Leo`, "AGNOLO", q, "them");
    const fromLeo = (q: string) => between(owner, user, () => `Leo to ${name}`, "LEONARDO", q, "leo");
    const lately: Q = {
      asker: "LEONARDO", kind: "lately", question: `What else is ${name.split(" ")[0]} posting about this week?`,
      run: async () => {
        const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
        const posts = (await this.ask.recent(user, since)).filter((p) => !p.reply_to).sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0));
        const { best, total } = this.pick(posts);
        const args = { account: user, since };
        if (!best) return { text: "Nothing new this week.", novel: false, found: total, tool: "ca_account_tweets", args };
        return { text: `This week, ${date(best.created_at)}: "${words(unquote(speakable(best.text)), 34)}"`, post: best, novel: !this.seenKinds.has("lately"), found: total, cite: best.id, tool: "ca_account_tweets", args };
      },
    };
    return [
      who,
      fromThem(`Has ${name.split(" ")[0]} talked to us before?`),
      fromLeo(`And what did Leo say to ${name.split(" ")[0]}?`),
      fromThem("Anything else from that side?"),
      fromLeo("And from Leo?"),
      lately,
      fromThem("One more from the archive?"),
      fromLeo("Anything else Leo said?"),
    ];
  }

  /** One turn: a question, the archive's answer read by Borges, and how interesting it was. */
  async next(): Promise<Line[]> {
    if (this.done) return [];
    const q = this.plan[this.i++];
    if (!q) { this.done = true; return []; }
    this.turns++; this.asked++;
    const r = await q.run().catch((e) => ({ text: `The archive didn't answer. ${String(e.message).slice(0, 60)}`, novel: false, found: 0, tool: "error", args: {} as Record<string, unknown>, post: undefined, cite: undefined }));
    this.seenKinds.add(q.kind);
    if (r.cite) this.cited.add(r.cite);
    if (r.novel) { this.stale = 0; this.answered++; } else this.stale++;
    // Airtime follows interest: a dull answer gets one short line, not a reading.
    const dull = !r.novel && r.post;
    if (dull) Object.assign(r, { text: `${r.found} posts there. Nothing new on this.`, post: undefined, cite: undefined });
    if (this.stale >= this.staleLimit || this.i >= this.plan.length) this.done = true;
    const lines: Line[] = [
      { speaker: q.asker, text: q.question, dur: 0 },
      {
        speaker: "BORGES", text: r.text, dur: 0, cite: r.cite,
        ask: { question: q.question, tool: r.tool, args: r.args, found: r.found, novel: r.novel },
        post: r.post ? { user: r.post.user, name: r.post.name, text: r.post.text, date: r.post.created_at, url: r.post.url } : undefined,
      },
    ];
    return lines;
  }
}
