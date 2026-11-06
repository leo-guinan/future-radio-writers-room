// The live run, rendered. The server owns the run (position, phases, timings); this page follows
// /live/feed/state.json, so every viewer and the compositor show the same frame at the same time.
(() => {
  const P = new URLSearchParams(location.search);
  const FEED = (P.get("feed") || location.origin).replace(/\/$/, "");
  const KIOSK = P.get("kiosk") === "1";

  // One station per browser: if another copy of this page opens, the older one goes silent, so a
  // restored or duplicate tab can never double the audio (which sounds like an echo).
  try {
    const me = `${Date.now()}-${Math.random()}`;
    const bc = new BroadcastChannel("future-radio-audio");
    bc.onmessage = (e) => { if (e.data > me) { document.querySelectorAll("video,audio").forEach((m) => { m.muted = true; m.pause(); }); window.__silenced = true; } };
    bc.postMessage(me);
    const _play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { if (window.__silenced) { this.muted = true; return Promise.resolve(); } return _play.call(this); };
  } catch {}
  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  if (P.get("bg") === "transparent") document.body.classList.add("transparent");
  const fit = () => { const s = Math.min(innerWidth / 1280, innerHeight / 720); stage.style.transform = `translate(${(innerWidth - 1280 * s) / 2}px, ${(innerHeight - 720 * s) / 2}px) scale(${s})`; };
  addEventListener("resize", fit); fit();
  $("feedurl").textContent = FEED.replace(/^https?:\/\//, "") + "/live/feed/state.json";

  let S = null, skew = 0;
  const now = () => Date.now() + skew; // server ms
  const fmt = (ms, o = {}) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York", ...o });
  const mmss = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(x).padStart(2, "0")}`; };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  setInterval(() => ($("clock").textContent = fmt(now(), { second: "2-digit" })), 250);

  async function pull() {
    try {
      const r = await fetch(FEED + "/live/feed/state.json", { cache: "no-store" });
      const s = await r.json();
      if (s.now) skew = s.now - Date.now();
      if (s.phase && s.phase !== "idle") S = s;
    } catch {}
  }

  // ---------------------------------------------------------------- audio: lines on the server's clock
  let actx = null;
  const played = new Set();
  function sting() {
    try {
      actx = actx || new AudioContext();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = "square"; o.frequency.setValueAtTime(880, actx.currentTime); o.frequency.exponentialRampToValueAtTime(220, actx.currentTime + 0.35);
      g.gain.setValueAtTime(0.12, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.45);
      o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.5);
    } catch {}
  }
  function play(key, src) {
    if (played.has(key) || !src) return;
    played.add(key);
    const a = new Audio(src.startsWith("http") ? src : FEED + src);
    a.play().catch(() => askTune());
  }
  function askTune() { if (!KIOSK) $("tune").hidden = false; }
  $("tune").onclick = () => { $("tune").hidden = true; actx = actx || new AudioContext(); vid.play().catch(() => {}); };

  // ---------------------------------------------------------------- program
  const vid = $("vid");
  let loaded = null, lastSeek = 0;
  function program(idx, offset, frozen) {
    const p = S.library[idx];
    if (!p) return;
    const inIdent = offset >= p.duration;
    document.body.classList.toggle("ident", inIdent && !frozen);
    $("ident-next").textContent = S.library[idx + 1]?.title ?? "The end of the library";
    if (loaded !== p.id) { loaded = p.id; vid.src = p.media.startsWith("http") ? p.media : FEED + p.media; vid.currentTime = Math.min(offset, p.duration); }
    if (frozen || inIdent) {
      if (!vid.paused) vid.pause();
      if (frozen && Math.abs(vid.currentTime - Math.min(offset, p.duration - 0.05)) > 0.3) vid.currentTime = Math.min(offset, p.duration - 0.05);
      return;
    }
    if (vid.error) { loaded = null; return; } // reload the file on the next tick
    if (Math.abs(vid.currentTime - offset) > 1.5 && Date.now() - lastSeek > 15000) { lastSeek = Date.now(); vid.currentTime = offset; }
    if (vid.paused) vid.play().catch(() => askTune());
  }

  // ---------------------------------------------------------------- the interrupt
  let lastN = 0;
  const LABEL = { reply: "REPLY", quote: "QUOTE POST", repost: "REPOSTS", like: "LIKES", bookmark: "BOOKMARKS", views: "VIEWS", reair: "RERUN" };
  function interrupt(c, phase, t) {
    const u = c.update;
    if (c.n !== lastN) { lastN = c.n; sting(); $("freeze-at").textContent = `${S.library[c.frozen.idx]?.title ?? ""} · ${mmss(c.frozen.offset)}`; }
    const showUpdate = phase === "announce" || phase === "react";
    $("update").hidden = !showUpdate;
    $("back").hidden = phase !== "return";
    if (!c.script) return; // still freezing while the cast prepare
    const sc = c.script;
    const span = (name) => c.phases.find((p) => p.phase === name);
    if (showUpdate) {
      $("u-kicker").textContent = `UPDATE · ${LABEL[u.type]} · INTERRUPTION #${c.n}`;
      $("u-announce").textContent = sc.announce.text;
      if (!u.text) $("u-post").hidden = true;
      $("u-memory").hidden = true;
      if (!$("u-cast").children.length || $("u-cast").dataset.n !== String(c.n)) { $("u-cast").dataset.n = String(c.n); $("u-cast").innerHTML = ["MRS. BUS", "BORGES", "AGNOLO", "LEONARDO"].map((s) => `<span data-s="${s}">${s}</span>`).join(""); }
    }
    // Which line is on, by the server's schedule (each line carries its start time).
    let speaking = null;
    const a = span("announce"), b = span("return");
    if (phase === "announce" && a) { speaking = sc.announce; play(`${c.n}:a`, sc.announce.audio); }
    if (phase === "react") {
      sc.react.forEach((l, i) => { if (l.at != null && t >= l.at && t < l.at + l.dur * 1000 + 300) { speaking = l; play(`${c.n}:r${i}:${l.at}`, l.audio); } });
      const r = span("react");
      const asked = sc.react.filter((l) => l.ask && l.at != null && l.at <= t);
      const good = asked.filter((l) => l.ask.novel).length;
      $("u-riff").textContent = `RIFF ${mmss((t - r.start) / 1000)} · ${asked.length} question${asked.length === 1 ? "" : "s"} · ${good} good answer${good === 1 ? "" : "s"}${sc.done ? "" : " · still asking"}`;
    }
    const cur = speaking && speaking.ask ? speaking : null;
    if (cur) {
      const args = Object.entries(cur.ask.args).map(([k, v]) => `${k}: ${v}`).join(", ");
      $("u-ask").className = "ask" + (cur.ask.novel ? "" : " dull");
      $("u-ask").innerHTML = `ASKING THE ARCHIVE · <b>${esc(cur.ask.tool)}(${esc(args)}) → ${cur.ask.found}</b>`;
    } else if (phase !== "react") $("u-ask").textContent = "";
    // The post on the card: the one being read now (an answer from the archive), else the update.
    const shown = speaking?.post ? { ...speaking.post, answer: true } : u.text ? { user: u.user, name: u.name, text: u.text, answer: false } : null;
    if (shown && showUpdate) {
      $("u-post").hidden = false;
      $("u-post").classList.toggle("answer", shown.answer);
      $("u-av").textContent = (shown.name || shown.user || "?").trim()[0];
      $("u-name").textContent = shown.name || shown.user;
      $("u-handle").textContent = (shown.user ? `@${shown.user}` : "") + (shown.date ? ` · ${new Date(shown.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · from the archive` : "");
      $("u-text").textContent = shown.text;
    }
    if (speaking?.cite && !speaking.post) {
      const m = sc.memory.find((x) => x.id === speaking.cite);
      if (m) { $("u-memory").hidden = false; $("u-memory").innerHTML = `<b>MEMORY · ${esc(m.id)}</b><br>${esc(m.text)}`; }
    }
    if (phase === "return" && b) { play(`${c.n}:b`, sc.returnLine.audio); $("back-title").textContent = `Resuming ${S.library[c.frozen.idx]?.title ?? ""} at ${mmss(c.frozen.offset)}${sc.segment ? ` · segment ${sc.segment} saved for reruns` : ""}`; }
    if (speaking) {
      $("u-sp").textContent = speaking.speaker;
      $("u-line").textContent = speaking.text;
      for (const s of $("u-cast").children) s.classList.toggle("on", s.dataset.s === speaking.speaker);
    }
  }

  // ---------------------------------------------------------------- rail and ledger
  function rail() {
    const st = S.stats;
    $("thread").textContent = `x.com/i/status/${S.thread}`;
    const finish = now() + st.remaining_secs * 1000;
    $("ledger").innerHTML = [
      ["Library", mmss(st.library_secs)],
      ["Played", mmss(st.played_secs)],
      ["Remaining", mmss(st.remaining_secs)],
      ["On air", mmss(st.elapsed_secs)],
      ["Added by the thread", mmss(st.added_by_thread_secs), "big"],
      ["Interruptions", String(st.interrupts + (S.current ? 1 : 0)), "big"],
      [st.complete ? "Finished" : "Finishes (if quiet)", fmt(st.complete ? S.now : finish)],
    ].map(([k, v, c]) => `<tr class="${c ?? ""}"><td>${k}</td><td>${v}</td></tr>`).join("");
    const items = [...S.done].reverse().slice(0, 6).map((d) => `<li>#${d.n} ${LABEL[d.type]}<small><b>${d.user ? "@" + esc(d.user) : ""}</b> ${mmss((d.ended - d.began) / 1000)} of broadcast</small></li>`);
    if (S.current) items.unshift(`<li class="rule">#${S.current.n} ${LABEL[S.current.update.type]} · on air now<small>${S.queued ? `${S.queued} more queued` : ""}</small></li>`);
    $("events").innerHTML = items.join("") || `<li class="dim">None yet. The thread is quiet.</li>`;
  }

  function render() {
    if (!S) return;
    const t = now();
    const frozen = S.phase !== "playing" && S.phase !== "complete";
    document.body.classList.toggle("frozen", frozen);
    document.body.classList.toggle("live", S.phase === "playing");
    $("onair-label").textContent = S.phase === "stopped" ? "STOPPED" : frozen ? "UPDATE" : S.phase === "complete" ? "COMPLETE" : "ON AIR";
    if (S.phase === "complete") {
      vid.pause(); $("update").hidden = true; $("back").hidden = true; $("end").hidden = false;
      $("end-runtime").textContent = `${mmss(S.stats.elapsed_secs)} to stream ${mmss(S.stats.library_secs)}`;
      $("end-detail").textContent = `The thread interrupted ${S.stats.interrupts} times and added ${mmss(S.stats.added_by_thread_secs)}.`;
      $("np-title").textContent = "The library is complete"; $("np-bar").style.width = "100%";
      rail(); return;
    }
    $("end").hidden = true;
    let idx = S.idx, offset = S.offset;
    if (S.phase === "playing") offset += (t - S.resumedAt) / 1000;
    else if (S.current) ({ idx, offset } = S.current.frozen);
    program(idx, offset, frozen);
    if (frozen && S.current) {
      const ph = S.current.phases.find((p) => t >= p.start && t < p.end)?.phase ?? S.phase;
      interrupt(S.current, ph, t);
    } else { $("update").hidden = true; $("back").hidden = true; }
    const p = S.library[idx];
    $("np-k").textContent = frozen ? "PAUSED" : "NOW PLAYING";
    $("np-title").textContent = p ? `${p.title} · ${mmss(Math.min(offset, p.duration))} / ${mmss(p.duration)}` : "";
    $("np-bar").style.width = `${Math.min(100, (S.stats.played_secs / S.stats.library_secs) * 100)}%`;
    rail();
  }

  (async () => {
    await pull();
    setInterval(pull, 500);
    setInterval(render, 100);
  })();
})();
