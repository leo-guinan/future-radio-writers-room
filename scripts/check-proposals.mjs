// Validates proposal front matter in a PR. Usage: node scripts/check-proposals.mjs <files...>
import { readFileSync } from "node:fs";
const LAYERS = ["record", "rules", "work", "roles", "characters", "scenes", "memory", "showrunner", "production", "participation", "deploy"];
const KINDS = ["capability", "change", "output", "question"];
const REUSE = ["cc-by", "show-only", "ask-first"];
let failed = 0;
for (const file of process.argv.slice(2)) {
  const fail = (m) => { console.error(`✗ ${file}: ${m}`); failed++; };
  if (file === "proposals/README.md" || file === "proposals/TEMPLATE.md") continue;
  if (!/^proposals\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(file)) { fail("name it proposals/YYYY-MM-DD-short-name.md"); continue; }
  const text = readFileSync(file, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) { fail("missing front matter between --- lines"); continue; }
  const fm = Object.fromEntries(m[1].split("\n").map((l) => l.replace(/\s+#.*$/, "")).filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
  if (!fm.title || fm.title === "A short name for the capability") fail("give it a title");
  if (!LAYERS.includes(fm.layer)) fail(`layer must be one of ${LAYERS.join(", ")}`);
  if (!KINDS.includes(fm.kind)) fail(`kind must be one of ${KINDS.join(", ")}`);
  if (!fm.from || fm.from === "your name or handle") fail("say who it's from (anonymous is fine)");
  if (!REUSE.includes(fm.reuse)) fail(`reuse must be one of ${REUSE.join(", ")}`);
  if (fm.status && fm.status !== "proposed") fail("leave status as 'proposed'; the producer sets it");
  for (const h of ["## What you want to be able to do", "## Why it matters", "## Done when"]) if (!m[2].includes(h)) fail(`missing section "${h}"`);
  if (!failed) console.log(`✓ ${file}`);
}
process.exit(failed ? 1 : 0);
