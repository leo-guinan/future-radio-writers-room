// Reactions are templates, not improvisation: Borges reads the post as written, Agnolo labels it,
// Leonardo reacts to the event (never to the claim). Nothing is paraphrased, judged or invented,
// which is what lets a bulletin air without review.

import { createHash } from "node:crypto";
import { OWNER, type Rule, type Tweet } from "./rules.ts";

export interface Line { speaker: "MRS. BUS" | "BORGES" | "AGNOLO" | "LEONARDO"; text: string; audio?: string | null }
export interface Bulletin { id: string; rule: string; kind: Rule["kind"]; post: Tweet; lines: Line[]; card: { kicker: string; label: string } }

const pick = <T,>(xs: T[], seed: string) => xs[parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) % xs.length];

/** Text a voice can read: links dropped, handles spoken as "at handle". */
export function speakable(text: string) {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^(\s*@\w{1,15})+\s*/, "")
    .replace(/@(\w{1,15})/g, "at $1")
    .replace(/\b(0?[1-9]|1[0-2])\.(0?[1-9]|[12]\d|3[01])\.(\d{4})\b/g, (_, m, d, y) => `${["January","February","March","April","May","June","July","August","September","October","November","December"][Number(m) - 1]} ${Number(d)}, ${y}`)
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const OPEN: Record<Rule["kind"], string[]> = {
  from: ["Bulletin! A new post from {name}.", "From the archive wire: {name} just posted."],
  mention: ["Bulletin! Somebody said our name.", "The wire picked up a mention."],
  reply: ["Bulletin! A reply just came in.", "Reply on the wire!"],
  keyword: ["Bulletin! The word \"{kw}\" just went by.", "On the wire: \"{kw}\"."],
};
const REACT: Record<Rule["kind"], string[]> = {
  from: ["Noted! That goes in the file for the next episode.", "Pinned to the board!", "The archive keeps moving. So do we!"],
  mention: ["They said our name! Bloom, never doom!", "We heard you! Thank you!", "Somebody's listening!"],
  reply: ["A reply! Writing it down.", "Conversation! That's the whole point.", "Good. Keep it coming."],
  keyword: ["There it is again!", "The word is out!", "Logged!"],
};

const OTHER_MENTION = { open: ["The wire picked up a mention of at {kw}.", "Somebody's talking about at {kw}."], react: ["Noted for the file!", "The conversation travels!"] };

export function bulletin(id: string, rule: Rule, post: Tweet): Bulletin {
  const ours = rule.value.replace(/^@/, "").toLowerCase() === OWNER().toLowerCase();
  const open = rule.kind === "mention" && !ours ? OTHER_MENTION.open : OPEN[rule.kind];
  const react = rule.kind === "mention" && !ours ? OTHER_MENTION.react : REACT[rule.kind];
  const at = new Date(post.posted_at ?? post.created_at);
  const hhmm = at.toLocaleString("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: process.env.STATION_TZ ?? "America/New_York" });
  const fill = (s: string) => s.replace("{user}", post.user).replace("{name}", post.name || post.user).replace("{kw}", rule.value);
  return {
    id,
    rule: rule.id,
    kind: rule.kind,
    post,
    card: { kicker: `ARCHIVE WIRE · ${rule.kind.toUpperCase()} · ${rule.value}`, label: "Automated bulletin. Public post, quoted as written. Aired without review." },
    lines: [
      { speaker: "MRS. BUS", text: fill(pick(open, post.id)) },
      { speaker: "BORGES", text: `${post.name || post.user}, at ${post.user}, ${hhmm}: "${speakable(post.text)}"` },
      { speaker: "AGNOLO", text: "Public post, quoted as written. Not verified by us." },
      { speaker: "LEONARDO", text: pick(react, post.id + rule.id) },
    ],
  };
}
