// Check Meta voice paths against a WAV file (mono 16-bit, 16 kHz).
// Usage: MODEL_API_KEY=... node --import tsx scripts/humain-voice-check.mjs <file.wav>
// Prints one-shot transcript, then streams the same audio over realtime.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
process.chdir(ROOT);
const [file] = process.argv.slice(2);
if (!file) throw new Error("usage: humain-voice-check.mjs <file.wav>");
const { MetaRealtimeTranscriber, MetaVoiceTranscriber, wavToPcm } = await import(`${ROOT}/src/humain/adapters.ts`);
const audio = readFileSync(file);
const one = new MetaVoiceTranscriber();
const r1 = await one.transcribe(audio, "audio/wav");
console.log(`one-shot chunks=${r1.chunks.length} cost=${r1.costUsd === null ? "unknown" : "$" + r1.costUsd}`);
for (const c of r1.chunks) console.log(`  ${c.text}`);
const pcm = wavToPcm(audio, 16000);
const SIZE = 2560;
async function* paced() {
  const t0 = Date.now();
  let sent = 0;
  for (let i = 0; i < pcm.length; i += SIZE) {
    yield pcm.subarray(i, i + SIZE);
    sent += Math.min(SIZE, pcm.length - i);
    const behind = (sent / 32000) * 1000 - (Date.now() - t0);
    if (behind > 0) await new Promise((r) => setTimeout(r, behind));
  }
}
const rt = new MetaRealtimeTranscriber();
const r2 = await rt.transcribeStream(paced(), 16000);
console.log(`realtime chunks=${r2.chunks.length} cost=${r2.costUsd === null ? "unknown" : "$" + r2.costUsd}`);
for (const c of r2.chunks) console.log(`  ${c.text}`);
