// Prints the ffmpeg tee target for every enabled route whose ${VARS} are all set.
// Stream keys come from the environment only; they are never written to the repo or the log.
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(process.argv[2] ?? "station/routes.json", "utf8"));
const outs = [];
for (const r of cfg.routes.filter((r) => r.enabled)) {
  const vars = [...r.url.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
  if (vars.some((v) => !process.env[v])) { console.error(`route ${r.name}: off (${vars.filter((v) => !process.env[v]).join(", ")} not set)`); continue; }
  const url = r.url.replace(/\$\{(\w+)\}/g, (_, v) => process.env[v]);
  const fmt = url.startsWith("rtmp") ? "flv" : "mp4";
  outs.push(`[f=${fmt}:onfail=ignore]${url.replace(/([|\[\]])/g, "\\$1")}`);
  console.error(`route ${r.name}: on`);
}
if (!outs.length) { console.error("no routes enabled"); process.exit(2); }
process.stdout.write(outs.join("|"));
