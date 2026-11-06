// Prints the ffmpeg tee target for every enabled route whose ${VARS} are all set, and logs each
// destination with its stream key masked. Stream keys come from the environment only.
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(process.argv[2] ?? "station/routes.json", "utf8"));
const env = (v) => (process.env[v] ?? "").trim().replace(/^["']|["']$/g, "");
const on = [];
for (const r of cfg.routes.filter((r) => r.enabled)) {
  const vars = [...r.url.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
  const missing = vars.filter((v) => !env(v));
  if (missing.length) { console.error(`route ${r.name}: off (${missing.join(", ")} not set)`); continue; }
  // Media Studio's URL often ends in "/": joining it with "/KEY" would give ".../x//KEY".
  const url = r.url.replace(/\$\{(\w+)\}/g, (_, v) => (v.endsWith("_URL") ? env(v).replace(/\/+$/, "") : env(v)));
  const secrets = vars.filter((v) => /KEY/.test(v)).map(env);
  const shown = secrets.reduce((u, k) => u.split(k).join(k.slice(0, 3) + "…" + k.slice(-2)), url);
  console.error(`route ${r.name}: on → ${shown}`);
  if (/^rtmps?:\/\//.test(url) && !/^rtmps?:\/\/[^/]+\/.+\/.+/.test(url)) console.error(`route ${r.name}: WARNING: expected rtmp(s)://host/app/KEY, got ${shown}`);
  on.push({ url, fmt: url.startsWith("rtmp") ? "flv" : "mp4" });
}
if (!on.length) { console.error("no routes enabled"); process.exit(2); }
// One route: fail loudly (the container restarts and the log says why). Several: one bad route
// must not take the others down.
const fail = on.length > 1 ? ":onfail=ignore" : "";
process.stdout.write(on.map((o) => `[f=${o.fmt}${fail}${o.fmt === "flv" ? ":flvflags=no_duration_filesize" : ""}]${o.url.replace(/([|\[\]])/g, "\\$1")}`).join("|"));
