// The cast's voices for bulletins: ElevenLabs text-to-speech, one request per line, with a hard
// daily character cap (ElevenLabs bills by character). Over the cap, or without a key, bulletins
// still air, captioned, in silence. The cap is checked before every request.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DATA } from "./rules.ts";
import type { Bulletin } from "./react.ts";

export const VOICES: Record<string, string> = {
  LEONARDO: "s5t7B6IvxVOp3Y7HQT6Q",
  BORGES: "TLugb594bskyzPlFSOkh",
  AGNOLO: "yowh82B72eMNrxcxHgBh",
  "MRS. BUS": "xN5u3GiLKTdbPJybr6kp",
};
const KEY = () => process.env.ELEVENLABS_API_KEY ?? "";
const CAP = () => Number(process.env.STATION_DAILY_CHARS ?? 20000);
const MODEL = () => process.env.STATION_TTS_MODEL ?? "eleven_v4";

function usage(): { day: string; chars: number } {
  const f = join(DATA(), "tts-usage.json");
  const day = new Date().toISOString().slice(0, 10);
  const u = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { day, chars: 0 };
  return u.day === day ? u : { day, chars: 0 };
}
function book(chars: number) {
  const u = usage();
  u.chars += chars;
  mkdirSync(DATA(), { recursive: true });
  writeFileSync(join(DATA(), "tts-usage.json"), JSON.stringify(u));
}

export type Speak = (voiceId: string, text: string) => Promise<Buffer>;

export const elevenlabs: Speak = async (voiceId, text) => {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": KEY(), "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: MODEL() }),
  });
  if (!r.ok) throw new Error(`ElevenLabs HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
};

/** Lines repeat (Agnolo's label, Mrs. Bus's openers), so every voiced line is cached by voice and
 * text; a cache hit costs nothing and needs no key. Seed the cache with `station voice-cache`. */
export const cacheFile = (voiceId: string, text: string) =>
  join(DATA(), "voice-cache", createHash("sha256").update(`${voiceId}\n${text}`).digest("hex").slice(0, 24) + ".mp3");

/** Voice each line; returns how many characters were spent and why any line stayed silent. */
export async function voice(b: Bulletin, speak: Speak | null = KEY() ? elevenlabs : null): Promise<{ chars: number; silent: string | null; cached: number }> {
  const dir = join(DATA(), "audio");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(DATA(), "voice-cache"), { recursive: true });
  const need = b.lines.filter((l) => !existsSync(cacheFile(VOICES[l.speaker], l.text))).reduce((s, l) => s + l.text.length, 0);
  const reason = !need ? null : !speak ? "no ELEVENLABS_API_KEY: uncached lines are captions only" : usage().chars + need > CAP() ? `daily voice cap (${CAP()} characters) reached: uncached lines are captions only` : null;
  let spent = 0, cached = 0;
  for (const [i, l] of b.lines.entries()) {
    const file = `${b.id}-${i}.mp3`;
    const c = cacheFile(VOICES[l.speaker], l.text);
    try {
      if (existsSync(c)) cached++;
      else if (!reason && speak) { writeFileSync(c, await speak(VOICES[l.speaker], l.text)); spent += l.text.length; }
      else { l.audio = null; continue; }
      copyFileSync(c, join(dir, file));
      l.audio = `/station/audio/${file}`;
    } catch (e: any) {
      l.audio = null;
      book(spent);
      return { chars: spent, silent: `voice failed: ${e.message}`, cached };
    }
  }
  book(spent);
  return { chars: spent, silent: reason, cached };
}
