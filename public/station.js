// Future Radio, the station frame. Everything here is computed from open feeds, so any copy of
// this page, hosted anywhere, can play any station: ?feed=https://another.station
(() => {
  const P = new URLSearchParams(location.search);
  const FEED = (P.get("feed") || location.origin).replace(/\/$/, "");
  const LAYERS = (P.get("layers") || "frame,program,bulletins,wire").split(",");
  const AUDIO = (P.get("audio") || "program,bulletins").split(",");
  const INNER = P.get("inner") || "youtube"; // youtube | local
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

  // ---------------------------------------------------------------- layers and scale
  for (const id of ["frame", "program", "bulletin", "wire"]) {
    const name = id === "bulletin" ? "bulletins" : id;
    if (!LAYERS.includes(name)) $(id).classList.add("off"), $(id).hidden = true;
  }
  if (!LAYERS.includes("program") && !LAYERS.includes("bulletins")) $("screen").hidden = true;
  if (P.get("bg") === "transparent") document.body.classList.add("transparent");
  const fit = () => {
    const s = Math.min(innerWidth / 1280, innerHeight / 720);
    stage.style.transform = `translate(${(innerWidth - 1280 * s) / 2}px, ${(innerHeight - 720 * s) / 2}px) scale(${s})`;
  };
  addEventListener("resize", fit);
  fit();
  $("feedname").textContent = FEED.replace(/^https?:\/\//, "");
  $("feedurl").textContent = FEED.replace(/^https?:\/\//, "") + "/station/feed";

  // ---------------------------------------------------------------- clock (server-corrected)
  let skew = 0; // server minus local, ms
  const now = () => (Date.now() + skew) / 1000;
  const fmt = (t, o = {}) => new Date(t * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York", ...o });
  setInterval(() => ($("clock").textContent = fmt(now(), { second: "2-digit" })), 250);

  // ---------------------------------------------------------------- schedule
  let lineup = null;
  function onAir(t) {
    const a = Date.parse(lineup.anchor) / 1000;
    const c = lineup.programs.reduce((s, p) => s + p.duration + lineup.ident_secs, 0);
    let s = a + Math.floor((t - a) / c) * c;
    for (let i = 0; i < lineup.programs.length; i++) {
      const p = lineup.programs[i];
      if (t < s + p.duration + lineup.ident_secs) return { p, i, start: s, offset: t - s, ident: t >= s + p.duration, next: lineup.programs[(i + 1) % lineup.programs.length] };
      s += p.duration + lineup.ident_secs;
    }
  }
  async function loadSchedule() {
    const r = await fetch(FEED + "/station/feed/schedule.json");
    const date = r.headers.get("date");
    lineup = await r.json();
    if (date) skew = Date.parse(date) + 500 - Date.now();
    lineup.programs.forEach((p) => p.media = p.media.startsWith("http") ? p.media : FEED + p.media);
  }

  // ---------------------------------------------------------------- program track
  const vid = $("vid");
  let yt = null, ytReady = null, current = null, duck = 1;
  const programVolume = () => (AUDIO.includes("program") ? duck : 0);
  function loadYT() {
    if (ytReady) return ytReady;
    ytReady = new Promise((res) => {
      window.onYouTubeIframeAPIReady = () => {
        yt = new YT.Player("yt", { playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1 }, events: { onReady: () => res() } });
      };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    });
    return ytReady;
  }
  async function tune() {
    const a = onAir(now());
    document.body.classList.toggle("ident", a.ident);
    document.body.classList.toggle("live", !a.ident);
    $("np-title").textContent = a.ident ? `Up next: ${a.next.title}` : a.p.title;
    $("np-bar").style.width = `${Math.min(100, (a.offset / a.p.duration) * 100)}%`;
    $("ident-next").textContent = a.next.title;
    if (a.ident) { vid.pause(); yt?.pauseVideo?.(); current = null; return; }
    const useYT = INNER !== "local" && a.p.youtube;
    if (current !== a.p.id) {
      current = a.p.id;
      if (useYT) {
        vid.hidden = true; vid.pause();
        await loadYT();
        yt.loadVideoById({ videoId: a.p.youtube, startSeconds: a.offset });
      } else {
        $("yt").style.display = "none";
        vid.hidden = false;
        vid.src = a.p.media;
        vid.currentTime = a.offset;
        vid.play().catch(() => askTune());
      }
    } else if (!useYT && Math.abs(vid.currentTime - a.offset) > 2.5) {
      vid.currentTime = a.offset; // drift: everyone stays on the same second
    } else if (useYT && yt?.getCurrentTime && Math.abs(yt.getCurrentTime() - a.offset) > 2.5) {
      yt.seekTo(a.offset, true);
    }
    vid.volume = programVolume();
    yt?.setVolume?.(programVolume() * 100);
  }
  function askTune() {
    if (KIOSK) return;
    $("tune").hidden = false;
  }
  $("tune").onclick = () => { $("tune").hidden = true; current = null; tune(); unlock(); };

  function upNext() {
    const a = onAir(now());
    const items = [];
    let t = a.start + a.p.duration + lineup.ident_secs;
    for (let k = 1; k <= 4; k++) {
      const p = lineup.programs[(a.i + k) % lineup.programs.length];
      items.push(`<li><b>${fmt(t)}</b><span>${esc(p.title)}</span></li>`);
      t += p.duration + lineup.ident_secs;
    }
    $("next").innerHTML = items.join("");
  }

  // ---------------------------------------------------------------- station track: the wire and bulletins
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const queue = [];
  let playing = false, audioUnlocked = KIOSK;
  const unlock = () => (audioUnlocked = true);
  function wire(e) {
    const ol = $("events");
    if (ol.firstElementChild?.classList.contains("dim") && !ol.firstElementChild.dataset.seq) ol.innerHTML = "";
    let html = "";
    if (e.type === "bulletin") html = `<li data-seq="${e.seq}">@${esc(e.bulletin.post.user)}<small>${esc(e.bulletin.kind)} · ${esc(e.bulletin.post.text).slice(0, 70)}…</small></li>`;
    else if (e.type === "skip") html = `<li class="skip" data-seq="${e.seq}">@${esc(e.post.user)} · not aired<small>${esc(e.reason)}</small></li>`;
    else if (e.type === "rule.added" || e.type === "rule.removed") html = `<li class="rule" data-seq="${e.seq}">${e.type === "rule.added" ? "now listening for" : "stopped"} ${esc(e.kind || "")} ${esc(e.value)}<small>programmed by voice · ${esc(e.program)}</small></li>`;
    if (!html) return;
    ol.insertAdjacentHTML("afterbegin", html);
    while (ol.children.length > 7) ol.lastElementChild.remove();
  }
  async function rules() {
    const r = await (await fetch(FEED + "/station/feed/rules.json")).json();
    $("rules").innerHTML = r.rules.filter((x) => x.enabled).map((x) => `${esc(x.kind)} · ${esc(x.value)}`).join("<br>") || "nothing yet";
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function playLine(l) {
    return new Promise((done) => {
      if (!l.audio || !AUDIO.includes("bulletins") || !audioUnlocked) return setTimeout(done, Math.max(2200, l.text.split(/\s+/).length * 380));
      const a = new Audio(l.audio.startsWith("http") ? l.audio : FEED + l.audio);
      a.onended = done;
      a.onerror = () => setTimeout(done, 1500);
      a.play().catch(() => setTimeout(done, Math.max(2200, l.text.split(/\s+/).length * 380)));
    });
  }
  async function runQueue() {
    if (playing || !queue.length || !LAYERS.includes("bulletins")) return;
    playing = true;
    const b = queue.shift();
    const box = $("bulletin");
    $("b-kicker").textContent = b.card.kicker;
    $("b-av").textContent = (b.post.name || b.post.user || "?").trim()[0];
    $("b-name").textContent = b.post.name || b.post.user;
    $("b-handle").textContent = `@${b.post.user} · ${new Date(b.post.posted_at || b.post.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}`;
    $("b-text").textContent = b.post.text;
    $("b-label").textContent = b.card.label;
    $("b-cast").innerHTML = ["MRS. BUS", "BORGES", "AGNOLO", "LEONARDO"].map((s) => `<span data-s="${s}">${s}</span>`).join("");
    box.hidden = false;
    duck = 0.12; tune();
    await sleep(500);
    for (const l of b.lines) {
      for (const s of $("b-cast").children) s.classList.toggle("on", s.dataset.s === l.speaker);
      $("b-sp").textContent = l.speaker;
      $("b-line").textContent = l.text;
      await playLine(l);
      await sleep(250);
    }
    await sleep(900);
    box.hidden = true;
    duck = 1; tune();
    playing = false;
    runQueue();
  }
  function onEvent(e) {
    wire(e);
    if (e.type === "bulletin") { queue.push(e.bulletin); runQueue(); }
    if (e.type === "rule.added" || e.type === "rule.removed") rules();
  }

  // ---------------------------------------------------------------- start
  (async () => {
    await loadSchedule();
    await tune(); upNext(); rules();
    setInterval(tune, 1000);
    setInterval(upNext, 15000);
    setInterval(loadSchedule, 600000);
    const past = await (await fetch(FEED + "/station/feed/events.json")).json();
    past.events.slice(-7).forEach(wire);
    const last = past.events.at(-1)?.seq ?? 0;
    const es = new EventSource(FEED + "/station/feed/live?since=" + last);
    for (const t of ["bulletin", "skip", "rule.added", "rule.removed"]) es.addEventListener(t, (m) => onEvent(JSON.parse(m.data)));
    window.__station = { queue, onAir: () => onAir(now()), feed: FEED };
  })();
})();
