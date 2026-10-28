// Run by .github/workflows/daily.yml each morning.
//
// ROOM_MODE=local: the room's log lives in this repo (room/); run the daily episode here.
// ROOM_MODE=remote: the room runs on a server. Collect what came in here (this repo's history
// and the attached asset repos), have the live room record the episode through the producer
// console, and save the transcript in this repo. Needs ROOM_URL and PRODUCER_TOKEN.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.ROOM_MODE || "local";
const day = process.env.DAY || new Date().toISOString().slice(0, 10);
const cli = ["--import", "tsx", "src/cli.ts"];

if (mode === "local") {
  const r = spawnSync(process.execPath, [...cli, "daily", "--day", day], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const { ROOM_URL, PRODUCER_TOKEN } = process.env;
if (!ROOM_URL || !PRODUCER_TOKEN) {
  console.log("::notice::No ROOM_URL variable or PRODUCER_TOKEN secret, so there's no live room to record in. Set them in the repo's settings to switch the morning episode on.");
  process.exit(0);
}

const digest = execFileSync(process.execPath, [...cli, "daily", "--collect-only", "--day", day], { encoding: "utf8", maxBuffer: 32 << 20 }).trim().split("\n").pop();
const res = await fetch(`${ROOM_URL.replace(/\/$/, "")}/api/producer/console`, {
  method: "POST",
  headers: { authorization: `Bearer ${PRODUCER_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ args: ["daily", "--digest-json", digest, "--md-only", "--no-write"] }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok || body.code !== 0) {
  console.error(`The room couldn't record today's episode (${res.status}): ${body.error ?? body.out ?? ""}`);
  process.exit(1);
}
const md = String(body.out).slice(String(body.out).indexOf("# "));
mkdirSync(join("episodes", "daily"), { recursive: true });
writeFileSync(join("episodes", "daily", `${day}.md`), md);
console.log(`Saved episodes/daily/${day}.md`);
