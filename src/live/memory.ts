// What the cast remember. Records come from the episodes' READMEs (what the films said, sourced),
// the thread itself, the station's past bulletins and this run's earlier updates. Retrieval is
// plain matching on handles, names and words: Borges may only say what a record says, and cites it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { events } from "../station/log.ts";
import { ROOT } from "../station/schedule.ts";
import type { Update } from "./types.ts";

export interface Rec { id: string; text: string; title: string; keys: string }

const clean = (s: string) => s.replace(/\*\*|`|\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();

let episodeCache: Rec[] | null = null;
export function episodeRecords(dir = join(ROOT, "submission")): Rec[] {
  if (episodeCache) return episodeCache;
  const out: Rec[] = [];
  if (existsSync(dir)) for (const slug of readdirSync(dir)) {
    const f = join(dir, slug, "README.md");
    if (!existsSync(f)) continue;
    const md = readFileSync(f, "utf8");
    const title = clean(md.split("\n")[0].replace(/^#\s*/, ""));
    md.split("\n").filter((l) => /^\s*-\s+/.test(l) || /^\*\*Video/.test(l)).forEach((l, i) => {
      const text = clean(l.replace(/^\s*-\s+/, "").replace(/^\*\*Video:\*\*\s*\S+,\s*/, ""));
      if (text.length > 30) out.push({ id: `ep:${slug}:${i}`, text, title, keys: text.toLowerCase() });
    });
  }
  return (episodeCache = out);
}

export function threadRecords(rootText: string): Rec[] {
  return rootText.split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 20).map((s, i) => ({ id: `thread:${i}`, text: s, title: "the thread", keys: s.toLowerCase() }));
}

export function historyRecords(): Rec[] {
  const out: Rec[] = [];
  for (const e of events()) {
    if (e.type === "bulletin") {
      const p = (e as any).bulletin.post;
      out.push({ id: `ev:${e.seq}`, text: `${p.name || p.user} posted: "${p.text}"`, title: "the archive wire", keys: `@${p.user} ${p.name} ${p.text}`.toLowerCase() });
    }
    if (e.type === "live.freeze") {
      const u = (e as any).update as Update;
      if (u.user) out.push({ id: `ev:${e.seq}`, text: `${u.name || u.user} ${u.type === "quote" ? "quoted the thread" : "replied to the thread"}${u.text ? `: "${u.text}"` : ""}`, title: "this run", keys: `@${u.user} ${u.name} ${u.text ?? ""}`.toLowerCase() });
    }
  }
  return out;
}

const STOP = new Set("about after again against because before being between could doesn't every first itself might other should since still their there these thing think those through under until where which while would people really".split(" "));

/** The records that bear on this update, best first. */
export function recall(u: Update, extra: Rec[] = [], k = 2): Rec[] {
  const handles = [u.user, ...(u.text?.match(/@(\w{1,15})/g) ?? []).map((h) => h.slice(1))].filter(Boolean).map((h) => h!.toLowerCase());
  const names = (u.name ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const words = [...new Set((u.text ?? "").toLowerCase().match(/[a-z][a-z'-]{5,}/g) ?? [])].filter((w) => !STOP.has(w));
  const pool = [...historyRecords().filter((r) => !u.user || !r.keys.includes(u.text?.toLowerCase().slice(0, 40) ?? "\u0000")), ...episodeRecords(), ...extra];
  const scored = pool.map((r) => {
    let s = 0;
    for (const h of handles) if (r.keys.includes(h)) s += 6;
    for (const n of names) if (r.keys.includes(n)) s += 3;
    for (const w of words) if (r.keys.includes(w)) s += 1;
    return { r, s };
  });
  return scored.filter((x) => x.s >= 3).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.r);
}
