// Voice for scenes, just in time. Scenes stay text until someone asks to hear a line; then the
// line is generated once in the speaker's production voice and cached by content, so the same
// words in the same voice are never paid for twice. Every generation is on the room's record
// (scene.voiced) and on the ledger: priced when TTS_PRICE_PER_1K_CHARS is set, otherwise as
// characters of unknown cost, never as free.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Room } from "../core/room.ts";
import { RuleError } from "../core/room.ts";
import { DATA_DIR } from "../core/open.ts";
import { playedBy } from "../core/cast.ts";
import { nameOf } from "../agents/characters.ts";
import { dressingRoom, reposEnabled } from "../repos/dressing-room.ts";

export const TTS_MODEL = () => process.env.TTS_MODEL ?? "eleven_v4";
export const cacheDir = () => process.env.VOICE_CACHE_DIR ?? join(DATA_DIR, "voice-cache");

export interface VoiceSettings {
  provider: string | null;
  id: string | null;
}

/** The production voice for a character, from their dressing room's voice/voice.json. */
export function voiceFor(character: string): VoiceSettings {
  if (process.env.VOICE_MAP) {
    // For tests and rooms without dressing rooms: {"borges":"voiceId", ...}
    const map = JSON.parse(process.env.VOICE_MAP) as Record<string, string>;
    if (map[character]) return { provider: "elevenlabs", id: map[character] };
  }
  if (!reposEnabled()) return { provider: null, id: null };
  try {
    const v = JSON.parse(dressingRoom(character).repo.read("voice/voice.json"));
    return { provider: v.provider ?? null, id: v.id ?? null };
  } catch {
    return { provider: null, id: null };
  }
}

/** What gets spoken: the line without bracketed cues. */
export const spokenText = (line: string) => line.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();

export const cacheKey = (voiceId: string, model: string, text: string) => createHash("sha256").update(JSON.stringify({ voiceId, model, text })).digest("hex");

export function cachedPath(key: string): string | null {
  const p = join(cacheDir(), `${key}.mp3`);
  return existsSync(p) ? p : null;
}

const inflight = new Map<string, Promise<string>>();

export interface VoiceOptions {
  requestedBy: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The audio for line `n` of a scene: from the cache if this exact line in this voice was
 * generated before, otherwise generated now, cached, and recorded. Returns the file path.
 */
export async function lineAudio(room: Room, sceneId: string, n: number, opts: VoiceOptions): Promise<{ path: string; generated: boolean }> {
  const s = room.mustScene(sceneId);
  const turn = s.turns.find((t) => t.n === n);
  if (!turn) throw new RuleError("scene", `${sceneId} has no line ${n}.`);
  const text = spokenText(turn.line);
  if (!text || /^\(offline/.test(turn.line)) throw new RuleError("scene", `Line ${n} of ${sceneId} was improvised offline; there is nothing to voice.`);
  const voice = voiceFor(turn.character);
  if (voice.provider !== "elevenlabs" || !voice.id) throw new RuleError("scene", `${nameOf(turn.character)} has no ElevenLabs voice in voice/voice.json.`);
  const model = TTS_MODEL();
  const key = cacheKey(voice.id, model, text);
  const hit = cachedPath(key);
  if (hit) return { path: hit, generated: false };
  if (!inflight.has(key)) {
    inflight.set(
      key,
      generate(voice.id, model, text, key, opts)
        .then((path) => {
          const bytes = readFileSync(path);
          const per1k = Number(process.env.TTS_PRICE_PER_1K_CHARS);
          const costUsd = Number.isFinite(per1k) && per1k > 0 ? Math.round((text.length / 1000) * per1k * 10000) / 10000 : null;
          room.recordSceneVoice(opts.requestedBy, {
            sceneId,
            n,
            character: turn.character,
            voiceId: voice.id!,
            model,
            cacheKey: key,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            characters: text.length,
            costUsd,
            requestedBy: opts.requestedBy,
          });
          room.store.append(
            "ledger.entry",
            playedBy("accounting"),
            {
              entryId: `L-${String(room.ledger.length + 1).padStart(4, "0")}`,
              ledger: "operations",
              kind: "expense",
              amount: costUsd ?? text.length,
              unit: costUsd === null ? "characters" : "usd",
              status: costUsd === null ? "unknown" : "observed",
              label: `Voice for ${sceneId} line ${n} (${turn.character}, ${model}, ${text.length} characters)`,
              episodeId: s.episodeId,
              ideaId: s.ideaId,
              evidence: `voice cache ${key.slice(0, 12)}`,
            },
            "producer",
          );
          return path;
        })
        .finally(() => inflight.delete(key)),
    );
  }
  return { path: await inflight.get(key)!, generated: true };
}

async function generate(voiceId: string, model: string, text: string, key: string, opts: VoiceOptions): Promise<string> {
  const apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new RuleError("voice", "Voice isn't switched on in this room yet (no ELEVENLABS_API_KEY). The scene is still here to read.");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!res.ok) throw new RuleError("voice", `The voice service said no (${res.status}). Try again later.`);
  const bytes = Buffer.from(await res.arrayBuffer());
  mkdirSync(cacheDir(), { recursive: true });
  const path = join(cacheDir(), `${key}.mp3`);
  writeFileSync(`${path}.part`, bytes);
  renameSync(`${path}.part`, path);
  return path;
}

/** Voice generations requested by patrons today (cache hits don't count). */
export function patronVoicesToday(room: Room): number {
  const day = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const s of room.scenes.values()) for (const v of Object.values(s.voiced)) if (v.requestedBy.startsWith("patron") && v.at.startsWith(day)) n++;
  return n;
}
