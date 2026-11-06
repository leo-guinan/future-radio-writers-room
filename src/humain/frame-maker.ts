// Frame Maker: the first working prototype capability. Builds a static webpage
// comparing two existing creative works with one hook and a vintage visitor
// counter. Runs inside the restricted workspace; every claim needs evidence.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RestrictedWorkspace } from "./executor.ts";
import { publishFrame, type FrameMeta } from "./frames.ts";

export interface WorkRef {
  work_id: string;
  title: string;
  kind: string;
  runtime_seconds?: number;
  url?: string;
}

export function loadWorks(root = process.cwd()): WorkRef[] {
  try {
    const catalog = JSON.parse(readFileSync(join(root, "catalog", "works.json"), "utf8")) as {
      works: Array<{ work_id: string; title: string; kind: string; youtube?: { url?: string }; releases?: Array<{ runtime_seconds?: number }> }>;
    };
    return catalog.works.map((w) => ({
      work_id: w.work_id,
      title: w.title,
      kind: w.kind,
      runtime_seconds: w.releases?.[0]?.runtime_seconds,
      url: w.youtube?.url,
    }));
  } catch {
    return [];
  }
}

function fmtRuntime(secs?: number): string {
  if (!secs) return "runtime unknown";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderComparison(a: WorkRef, b: WorkRef, hook: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(hook)}</title>
<style>
  body { background: #0d0d12; color: #e8e0c8; font-family: Georgia, serif; max-width: 860px; margin: 2rem auto; padding: 0 1.2rem; }
  .hook { font-size: 1.9rem; border-bottom: 3px double #8a6d3b; padding-bottom: .6rem; }
  .works { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1.5rem 0; }
  .work { border: 1px solid #8a6d3b; border-radius: 8px; padding: 1rem; background: #14141c; }
  .work h2 { margin-top: 0; font-size: 1.2rem; }
  .work a { color: #d8b25c; }
  .counter { text-align: center; margin-top: 2rem; font-family: "Courier New", monospace; }
  .odometer { display: inline-block; background: #000; border: 3px inset #666; border-radius: 6px; padding: .3rem .8rem; letter-spacing: .35rem; font-size: 2rem; color: #7dff8a; }
  .made { text-align: center; opacity: .6; font-size: .85rem; margin-top: 1rem; }
</style>
</head>
<body>
  <p><a href="/humain.html" style="color:#d8b25c">&larr; HumAIn OS session</a></p>
  <h1 class="hook">${esc(hook)}</h1>
  <div class="works">
    <div class="work" data-work="${esc(a.work_id)}">
      <h2>${esc(a.title)}</h2>
      <p>Kind: ${esc(a.kind)} &middot; ${esc(fmtRuntime(a.runtime_seconds))}</p>
      ${a.url ? `<p><a href="${esc(a.url)}">Watch / listen</a></p>` : "<p>Unreleased.</p>"}
    </div>
    <div class="work" data-work="${esc(b.work_id)}">
      <h2>${esc(b.title)}</h2>
      <p>Kind: ${esc(b.kind)} &middot; ${esc(fmtRuntime(b.runtime_seconds))}</p>
      ${b.url ? `<p><a href="${esc(b.url)}">Watch / listen</a></p>` : "<p>Unreleased.</p>"}
    </div>
  </div>
  <div class="counter" data-testid="visitor-counter">
    <div>You are visitor</div>
    <div class="odometer" id="odometer">000000</div>
    <div>since the static began</div>
    <div class="server-counts" data-testid="server-counts"><strong data-c="unique">0</strong> unique souls across <strong data-c="human">0</strong> visits (<strong data-c="verify">0</strong> verification passes)</div>
  </div>
  <p class="made">Framed by HumAIn OS Frame Maker prototype. Counter is per-browser (localStorage).</p>
<script>
(function () {
  var key = "humain-visitor-count";
  var n = 1;
  try { n = (parseInt(localStorage.getItem(key) || "0", 10) || 0) + 1; localStorage.setItem(key, String(n)); }
  catch (e) { n = 1; }
  document.getElementById("odometer").textContent = String(n).padStart(6, "0");
})();
</script>
</body>
</html>
`;
}

export interface FrameResult {
  file: string;
  sha256: string;
  bytes: number;
  checks: string[];
}

/** Execute the frame-maker + counter build tasks inside the workspace, with evidence. */
export function buildFrame(ws: RestrictedWorkspace, a: WorkRef, b: WorkRef, hook: string): FrameResult {
  const html = renderComparison(a, b, hook);
  const { bytes, sha256 } = ws.writeFile("frame/index.html", html);
  const checks: string[] = [];
  const back = ws.readFile("frame/index.html");
  if (!back.includes(esc(hook))) throw new Error("Evidence check failed: hook missing from page.");
  checks.push("hook present");
  if (!back.includes('data-testid="visitor-counter"')) throw new Error("Evidence check failed: counter missing.");
  checks.push("visitor counter present");
  if (!back.includes(`data-work="${a.work_id}"`) || !back.includes(`data-work="${b.work_id}"`))
    throw new Error("Evidence check failed: both works missing.");
  checks.push("both works present");
  checks.push(`sha256:${sha256.slice(0, 12)}`);
  return { file: "frame/index.html", sha256, bytes, checks };
}

/** Publish a frame to the persistent registry with evidence checks. */
export function buildFrameToRegistry(
  frameId: string,
  sessionId: string,
  hook: string,
  a: WorkRef,
  b: WorkRef,
): { meta: FrameMeta; checks: string[] } {
  const html = renderComparison(a, b, hook);
  if (!html.includes(esc(hook))) throw new Error("Evidence check failed: hook missing from page.");
  if (!html.includes('data-testid="visitor-counter"')) throw new Error("Evidence check failed: counter missing.");
  if (!html.includes(`data-work="${a.work_id}"`) || !html.includes(`data-work="${b.work_id}"`))
    throw new Error("Evidence check failed: both works missing.");
  const meta = publishFrame(frameId, sessionId, hook, a.work_id, b.work_id, html);
  return { meta, checks: ["hook present", "visitor counter present", "both works present", `sha256:${meta.sha256.slice(0, 12)}`] };
}

export function workById(works: WorkRef[], workId: string): WorkRef {
  const found = works.find((w) => w.work_id === workId);
  if (!found) throw new Error(`Unknown work ${workId} in catalog.`);
  return found;
}

export function worksFor(plan: { tasks: Array<{ detail: string }> }, works: WorkRef[]): [WorkRef, WorkRef] {
  const text = plan.tasks.map((t) => t.detail).join(" ");
  const found = works.filter((w) => text.includes(w.work_id));
  const fallback: WorkRef = { work_id: "unknown", title: "An unmade episode", kind: "episode" };
  return [found[0] ?? works[0] ?? fallback, found[1] ?? works[1] ?? fallback];
}
