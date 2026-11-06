// What is the captured page actually doing? Asks Chrome over its debugging port (no packages:
// Node 22's built-in WebSocket) and prints one line: the phase, the program, whether the video is
// playing and where, and any media error. The compositor logs this every minute, so "the screen
// is static" turns into a reason (paused, stalled, error 4 = codec, stuck in ident, idle run).
//   node deploy/station/pagestate.mjs [port]
const port = process.argv[2] || 9222;
const fail = (m) => { console.log(`page state: ${m}`); process.exit(0); };
const t = setTimeout(() => fail("no answer from Chrome"), 8000);
const tabs = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => fail("Chrome debugging port not reachable"));
const page = tabs.find((x) => x.type === "page");
if (!page) fail("no page open");
const ws = new WebSocket(page.webSocketDebuggerUrl);
const expr = `(() => {
  const v = document.querySelector("video"), b = document.body;
  const err = v?.error ? ({1:"aborted",2:"network",3:"decode",4:"unsupported (codec?)"})[v.error.code] : "";
  const canH264 = document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
  return [
    "class=" + (b.className || "-"),
    "title=" + (document.getElementById("np-title")?.textContent || document.getElementById("onair-label")?.textContent || "-"),
    "src=" + (v?.currentSrc || "").split("/").pop(),
    v ? (v.paused ? "PAUSED" : "playing") : "no video",
    v ? "t=" + v.currentTime.toFixed(1) + "/" + (v.duration || 0).toFixed(0) : "",
    v ? "ready=" + v.readyState : "",
    err ? "ERROR=" + err : "",
    "h264=" + (canH264 || "no"),
    "silenced=" + !!window.__silenced,
  ].filter(Boolean).join(" ");
})()`;
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id !== 1) return;
  clearTimeout(t);
  console.log(`page state: ${d.result?.result?.value ?? JSON.stringify(d.result?.exceptionDetails?.text ?? d)}`);
  ws.close();
  process.exit(0);
};
ws.onerror = () => fail("debugging socket error");
