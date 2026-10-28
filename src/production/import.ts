// Import an episode that was made before (or outside) the writers' room, so it enters the
// record the same way a room-made episode would: ideas and decisions, scenes, the stage
// path, the locked release, the three ledgers, the forecasts it made, the cast's
// appearances and canon in their dressing rooms, and an episode repo.
//
// Imports are idempotent: run again and nothing is recorded twice. The room log says
// what was imported and from where; nothing pretends to have happened at an earlier time.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { sha256 } from "../core/events.ts";
import type { Room } from "../core/room.ts";
import { CAST, type Character, type IdeaStatus, type LedgerEntry, type OutputKind } from "../core/types.ts";
import { dressingRoom, reposEnabled } from "../repos/dressing-room.ts";
import { EpisodeRepo } from "../repos/episode-repo.ts";

interface Imported {
  episodeId: string;
  title: string;
  imported: { at: string; by: string; sources: string[] };
  logline: string;
  tagline?: string;
  cast: Array<{ character: string; role?: string; voice?: { provider: string; name: string; id: string; kind?: string; direction?: string } }>;
  scenes: Array<{ sceneId: string; title: string; role: string; start: string; minutes: [number, number]; summary: string; question: string }>;
  chaptersSource?: string;
  ideas: Array<{ title: string; question: string; output: OutputKind; episodeId?: string; status: IdeaStatus; reason: string; result?: string }>;
  decisions: string[];
  canon: Partial<Record<Character, string[]>>;
  release: {
    version: string;
    file: string;
    sha256: string;
    bytes?: number;
    format?: string;
    runtimeSeconds: number;
    madeAt?: string;
    uri: string;
    invitation: string;
    media?: Array<{ file: string; sha256: string }>;
  };
  ledger: Array<Omit<LedgerEntry, "entryId">>;
  attribution?: string;
  forecasts: Array<{ claim: string; metric?: string; target?: string; dueBy: string; verbatim: boolean }>;
  open: string[];
  learned: string;
}

export interface ImportReport {
  episodeId: string;
  recorded: boolean; // false when the room already had this release
  events: number;
  appearances: Array<{ character: Character; lines: number; file: string }>;
  canonAdded: number;
  repo: { name: string; sha: string; files: number } | null;
  missingMedia: string[];
}

// "**LEONARDO:** line" or "**AGNOLO** (off): line"
const SPEAKER = /^\*\*([A-Z][A-Z ]+?)(?::\*\*|\*\*(?:\s*\(([^)]*)\))?:)\s*(.+)$/;

/** Every line a character speaks in a released script, in order. */
export function linesFor(script: string, character: string): string[] {
  const name = character.toUpperCase();
  const out: string[] = [];
  for (const raw of script.split("\n")) {
    const m = raw.trim().match(SPEAKER);
    if (m && m[1].trim() === name) out.push(m[3].trim());
  }
  return out;
}

export function importEpisode(room: Room, dir: string, opts: { actor?: string; mediaDir?: string } = {}): ImportReport {
  const actor = opts.actor ?? "leo";
  const spec = JSON.parse(readFileSync(join(dir, "episode.json"), "utf8")) as Imported;
  const script = readFileSync(join(dir, "SCRIPT.md"), "utf8");
  const ep = room.mustEpisode(spec.episodeId);
  const before = room.store.all().length;
  const source = `Imported from the production record: ${spec.imported.sources.join(" · ")}`;
  const already = ep.releases.some((r) => r.sha256 === spec.release.sha256);

  if (!already) {
    // Ideas, with the decisions that were actually made about them.
    for (const i of spec.ideas) {
      const ev = room.proposeIdea(actor, { title: i.title, question: i.question, output: i.output, source, episodeId: i.episodeId, contributor: { name: "Leo", credit: true, reuse: "cc-by" } });
      const ideaId = (ev.payload as { ideaId: string }).ideaId;
      if (i.status === "produced") {
        room.transitionIdea(actor, { ideaId, to: "selected", reason: i.reason });
        room.transitionIdea(actor, { ideaId, to: "produced", reason: "Imported as produced.", result: i.result });
      } else if (i.status !== "proposed") {
        room.transitionIdea(actor, { ideaId, to: i.status, reason: i.reason });
      }
    }

    // Scenes as released, then the stage path the episode actually took.
    for (const s of spec.scenes) {
      room.addScene(actor, { sceneId: s.sceneId, episodeId: spec.episodeId, title: s.title, role: s.role, minutes: s.minutes, summary: `${s.summary} (starts ${s.start})`, question: s.question, core: true });
    }
    room.advanceEpisode(actor, spec.episodeId, "select", `Imported: ${spec.scenes.length} scenes as released.`);
    for (const s of spec.scenes) room.selectScene(actor, { episodeId: spec.episodeId, sceneId: s.sceneId, selected: true, reason: "In the released cut." });
    room.advanceEpisode(actor, spec.episodeId, "write", "Imported: the production doc's script.");
    room.addAsset(actor, { episodeId: spec.episodeId, kind: "script", label: "Released script", uri: `seed/episodes/${basename(dir)}/SCRIPT.md`, sha256: sha256(script) });
    room.advanceEpisode(actor, spec.episodeId, "generate", "Imported: generated in ElevenLabs; see assets.json.");
    room.addAsset(actor, { episodeId: spec.episodeId, kind: "audio", label: "Generated dialogue, music and effects (ElevenLabs flow)", uri: `seed/episodes/${basename(dir)}/assets.json`, sha256: sha256(readFileSync(join(dir, "assets.json"), "utf8")) });
    room.advanceEpisode(actor, spec.episodeId, "review", "Imported: the final mix was transcribed as a check.");
    room.advanceEpisode(actor, spec.episodeId, "publish", spec.decisions.at(-1));
    room.release(actor, {
      episodeId: spec.episodeId,
      version: spec.release.version,
      uri: spec.release.uri,
      sha256: spec.release.sha256,
      scriptSha256: sha256(script),
      runtimeMinutes: Math.round((spec.release.runtimeSeconds / 60) * 100) / 100,
      invitation: spec.release.invitation,
    });

    // Agnolo's three ledgers, then close the loop.
    for (const l of spec.ledger) room.addLedgerEntry(actor, { ...l, episodeId: spec.episodeId }, l.kind === "obligation" || l.ledger === "effort" ? "public" : "producer");
    room.advanceEpisode(actor, spec.episodeId, "account", spec.learned);

    // What the episode predicted, recorded now so the finale can hold it to account.
    for (const f of spec.forecasts) room.recordForecast(actor, { ...f, source: `${spec.episodeId} ${spec.release.version}` }, "public");
  }

  const report: ImportReport = { episodeId: spec.episodeId, recorded: !already, events: room.store.all().length - before, appearances: [], canonAdded: 0, repo: null, missingMedia: [] };
  if (!reposEnabled()) return report;

  // The cast: voices, appearances and canon go into their dressing rooms.
  const releaseEvent = room.store.all().find((e) => e.type === "episode.released" && (e.payload as any).sha256 === spec.release.sha256)!;
  for (const member of spec.cast) {
    const c = member.character as Character;
    if (!CAST.includes(c)) continue;
    const dr = dressingRoom(c).ensure();
    if (member.voice) dr.setVoice(member.voice);
    const lines = linesFor(script, c);
    if (lines.length) {
      const a = dr.recordAppearance({
        episodeId: spec.episodeId,
        version: spec.release.version,
        title: spec.title,
        lines,
        releaseSha256: spec.release.sha256,
        at: spec.release.madeAt ?? releaseEvent.ts,
        eventId: releaseEvent.id,
        eventHash: releaseEvent.hash,
        script: `seed/episodes/${basename(dir)}/SCRIPT.md`,
      });
      report.appearances.push({ character: c, lines: lines.length, file: a.file });
      if (a.created) room.store.append("repo.commit", "system", { repo: dr.repo.name, sha: a.sha, message: `Appears in ${spec.episodeId} ${spec.release.version}`, files: [a.file], episodeId: spec.episodeId }, "public");
    }
    for (const note of spec.canon[c] ?? []) {
      if (dr.hasNote(note)) continue;
      dr.remember(note, `${spec.episodeId} ${spec.release.version}, as released`);
      report.canonAdded++;
    }
  }

  // The episode repo: the show plan, the record, and the cast projected as of this release.
  // Once written it is a fixed reference, like the release: a re-import leaves it alone.
  const repo = new EpisodeRepo(spec.episodeId);
  repo.ensure(ep);
  if (!report.recorded && repo.repo.has("RELEASE.md")) {
    report.repo = { name: repo.repo.name, sha: repo.repo.head(), files: 0 };
    for (const m of spec.release.media ?? []) {
      const src = opts.mediaDir ? join(opts.mediaDir, basename(m.file)) : null;
      if (!src || !existsSync(src) || sha256(readFileSync(src)) !== m.sha256) report.missingMedia.push(m.file);
    }
    return report;
  }
  const files: Record<string, string> = {
    "SCRIPT.md": script,
    "assets.json": readFileSync(join(dir, "assets.json"), "utf8"),
    "ASSETS.md": renderAssets(JSON.parse(readFileSync(join(dir, "assets.json"), "utf8"))),
    "RELEASE.md": renderRelease(spec, room),
    "DECISIONS.md": `# Decisions — ${spec.episodeId}\n\n${spec.decisions.map((d) => `- ${d}`).join("\n")}\n`,
    "LEDGER.md": renderLedger(spec),
    "OPEN.md": `# Still open — ${spec.episodeId}\n\n${spec.open.map((o) => `- [ ] ${o}`).join("\n")}\n`,
    "README.md": renderReadme(spec),
  };
  const songsDir = join(dir, "songs");
  if (existsSync(songsDir)) for (const f of readdirSync(songsDir)) files[`songs/${f}`] = readFileSync(join(songsDir, f), "utf8");
  for (const [rel, content] of Object.entries(files)) repo.repo.write(rel, content);
  // Binaries live in the GitHub release for this tag, not in git. Verify them if we have them.
  for (const m of spec.release.media ?? []) {
    const src = opts.mediaDir ? join(opts.mediaDir, basename(m.file)) : null;
    if (!src || !existsSync(src) || sha256(readFileSync(src)) !== m.sha256) report.missingMedia.push(m.file);
  }
  const query = [spec.logline, ...spec.scenes.map((s) => `${s.title} ${s.summary}`)].join(" ");
  const projections = (["borges", "leonardo", "agnolo"] as const).map((c) => repo.project(c, query));
  const sha = repo.repo.commit(`Import ${spec.episodeId} "${spec.title}" as released (${spec.release.version})`);
  repo.repo.tag(spec.release.version, `${spec.episodeId} ${spec.release.version}: ${spec.release.file} sha256 ${spec.release.sha256}`);
  if (report.recorded)
    room.store.append("repo.commit", "system", { repo: repo.repo.name, sha, message: `Imported ${spec.episodeId} as released`, files: [...Object.keys(files), ...projections.map((p) => p.file)], episodeId: spec.episodeId }, "public");
  report.repo = { name: repo.repo.name, sha, files: Object.keys(files).length + projections.length };
  return report;
}

/** Import every episode under seed/episodes/. */
export function importAll(room: Room, root = join(process.cwd(), "seed", "episodes"), opts: { actor?: string; mediaDir?: string } = {}) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => existsSync(join(root, d, "episode.json")))
    .sort()
    .map((d) => importEpisode(room, join(root, d), opts));
}

function renderReadme(s: Imported) {
  return `# Future Radio — ${s.episodeId}: ${s.title}

${s.tagline ? `*${s.tagline}*\n\n` : ""}${s.logline}

**Released ${s.release.version}** · ${fmtTime(s.release.runtimeSeconds)} · \`sha256 ${s.release.sha256}\`
→ [${s.release.file}](${s.release.uri})

| File | What it holds |
|---|---|
| \`SHOW_PLAN.md\` | The plan the episode was made against |
| \`SCRIPT.md\` | The script as released |
| \`songs/\` | Lyrics for the songs in the episode |
| \`RELEASE.md\` | The released file, its checksum, chapters and media |
| \`ASSETS.md\` · \`assets.json\` | Every generation behind it, with cost |
| \`LEDGER.md\` | Agnolo's ledger: cash, credits, and the time it took |
| \`DECISIONS.md\` | Production choices and why |
| \`OPEN.md\` | What is still unresolved |
| \`cast/\` | The characters as of this release, projected from their dressing rooms |

This episode was made before the writers' room existed and was imported from its production
record. The release is locked: later episodes can answer it, never rewrite it.
`;
}

function renderRelease(s: Imported, room: Room) {
  const ep = room.mustEpisode(s.episodeId);
  const scenes = [...ep.scenes.values()];
  return `# Release — ${s.episodeId} ${s.release.version}

| | |
|---|---|
| File | [${s.release.file}](${s.release.uri}) |
| sha256 | \`${s.release.sha256}\` |
| Size | ${s.release.bytes ? `${(s.release.bytes / 1e6).toFixed(1)} MB` : "—"} |
| Format | ${s.release.format ?? "—"} |
| Runtime | ${fmtTime(s.release.runtimeSeconds)} |
| Made | ${s.release.madeAt ?? "—"} |

## Chapters

${s.scenes.map((c) => `- ${c.start} ${c.title}`).join("\n")}

_${s.chaptersSource ?? ""}_

## What it asks of the listener

${s.release.invitation}

## Media

Attached to the [\`${s.release.version}\` release](${releaseBase(s)}) alongside the episode file:

${(s.release.media ?? []).map((m) => `- [${basename(m.file)}](${releaseBase(s)}/${basename(m.file)}) — sha256 \`${m.sha256}\``).join("\n") || "—"}

## In the room

${scenes.length} scenes, all in the released cut. The release is locked in the writers' room log; this repo is tagged \`${s.release.version}\` at the commit that recorded it.
`;
}

function renderLedger(s: Imported) {
  const row = (l: Imported["ledger"][number]) => `| ${l.label} | ${l.ledger} · ${l.kind} | ${l.unit === "usd" ? `$${l.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : `${l.amount} ${l.unit}`} | ${l.status} |`;
  return `# Agnolo's ledger — ${s.episodeId}

| Line | Ledger | Amount | Status |
|---|---|---|---|
${s.ledger.map(row).join("\n")}
| Recovered from listeners | operations · receipt | $0.00 | observed |

${s.attribution ?? ""}

## What it predicted

${s.forecasts.map((f) => `- ${f.claim} — due ${f.dueBy}`).join("\n")}

## What it taught

${s.learned}
`;
}

function renderAssets(a: any) {
  const n = a.newForEpisode;
  return `# Assets — what this episode was made from

Source: ElevenLabs flow [\`${a.source.flow}\`](${a.source.flowUrl}). ${a.source.note}

## New for this episode — ${n.generations} generations, $${n.costUsd} (${n.costKind})

| Asset | Generations | Cost |
|---|---|---|
| Dialogue: ${n.dialogue.lines} lines, ${n.dialogue.takesPerLine} takes each | ${n.dialogue.generations} | $${n.dialogue.costUsd} |
| Music: ${n.music.map((m: any) => m.label).join(", ")} | — | $${n.musicCostUsd} |
| Effects and room beds | ${n.sfxGenerations} | $${n.sfxCostUsd} |
| Transcription checks | ${n.checks.transcriptions} | $${n.checks.costUsd} |

${n.dialogue.note}

**Music**
${n.music.map((m: any) => `- ${m.label} (\`${m.node}\`)${m.used === false ? ` — not used: ${m.note}` : ""}${m.takes ? `\n${m.takes.map((t: any) => `  - take ${t.take} \`${t.node}\`${t.used ? " — **in the mix**" : ""}${t.note ? `, ${t.note}` : ""}`).join("\n")}` : ""}`).join("\n")}

**Effects:** ${n.sfx.map((x: any) => `\`${x.label}\``).join(", ")}

**Final mix check:** ${n.checks.finalMixCheck.result}.

## Reused from earlier work — about $${a.reused.costUsd}${a.reused.costIsEstimate ? " (estimate)" : ""}

${a.reused.items.map((r: any) => `- ${r.label}${r.node ? ` (\`${r.node}\`)` : ""}${r.use ? ` — ${r.use}` : ""}${r.note ? ` _(${r.note})_` : ""}`).join("\n")}

## Images

Attached to the release (see RELEASE.md):

${a.images.map((i: any) => `- ${i.label}${i.node ? ` (\`${i.node}\`, ${i.model})` : ` — ${i.service}`}: ${i.files.map((f: string) => `\`${basename(f)}\``).join(", ")}`).join("\n")}

**Attributed generation cost:** about $${a.attributedCostUsd}.
`;
}

/** The download URL base for a release's assets, derived from the episode file's own URI. */
const releaseBase = (s: Imported) => s.release.uri.slice(0, s.release.uri.lastIndexOf("/"));

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
