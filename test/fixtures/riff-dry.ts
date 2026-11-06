// Dry run of one segment (no voices): prints every line of the riff about Jim's quote.
//   DATA_DIR=... node --import tsx test/fixtures/riff-dry.ts <thread-fixture.json> [out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { FixtureAsk } from "../../src/live/ask.ts";
import { continueRiff, opening } from "../../src/live/script.ts";
import { newRun } from "../../src/live/run.ts";
import { diff } from "../../src/live/thread.ts";

const f = JSON.parse(readFileSync(process.argv[2], "utf8"));
const ask = FixtureAsk.fromFile(new URL("./ask-jim.json", import.meta.url).pathname);
const s = newRun("D", "1", [], Date.now(), 4);
const out: Record<string, string[]> = {};
let n = 0;
for (let i = 1; i < f.steps.length; i++) for (const u of diff(f.steps[i - 1].snapshot, f.steps[i].snapshot)) {
  n++;
  const { script, riff } = await opening(u, s, n, f.root_text, ask);
  const all = [script.announce, ...script.react];
  while (riff && !riff.done) all.push(...(await continueRiff(u, riff, s, n)));
  all.push(script.returnLine);
  console.log(`\n#${n} ${u.type}`);
  for (const l of all) {
    console.log(l.speaker.padEnd(9), (Math.round(l.dur * 10) / 10).toString().padStart(5), "|", l.text, l.ask ? `   [${l.ask.tool} found=${l.ask.found} novel=${l.ask.novel}]` : "");
    (out[l.speaker] ??= []).includes(l.text) || out[l.speaker].push(l.text);
  }
  console.log("segment ≈", Math.round(all.reduce((t, l) => t + l.dur + 0.3, 0)), "s", riff ? `· ${riff.turns} questions, ${riff.answered} good answers` : "");
}
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
