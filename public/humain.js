// HumAIn OS client. Raw audio is ephemeral: MediaRecorder chunks are discarded
// and never uploaded. Only transcript text (on-device speech recognition, or
// typed fallback) is sent to the server.

const $ = (id) => document.getElementById(id);
let sessionId = null;
let windowMin = 5;
let pollTimer = null;
let recognition = null;
let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];
let lastState = null;
let lastRevKey = null;
const cutEpisode = new URLSearchParams(location.search).get("cut");

// Revise mode: the session targets a cut file, not a frame.
async function loadCutBanner() {
  if (!cutEpisode) return;
  try {
    const c = await api(`/api/humain/cuts/${encodeURIComponent(cutEpisode)}`);
    $("cutBanner").innerHTML = `Revising: ${escapeHtml(c.title)}, take ${c.take} <span class="muted">(${c.lines} voice lines)</span> <a href="${escapeHtml(c.roughCutUrl)}" target="_blank">rough cut</a>`;
    $("cutBanner").hidden = false;
  } catch (e) {
    $("cutBanner").textContent = `Cannot revise ${cutEpisode}: ${e.message}`;
    $("cutBanner").hidden = false;
  }
}
loadCutBanner();

for (const b of document.querySelectorAll(".winbtn")) {
  b.addEventListener("click", () => {
    document.querySelectorAll(".winbtn").forEach((x) => x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", "true");
    windowMin = Number(b.dataset.min);
  });
}

async function api(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function mmss(ms) {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

$("open").addEventListener("click", async () => {
  try {
    const s = await api("/api/humain/sessions", "POST", { inputWindowMin: windowMin, saveTranscript: $("saveTranscript").checked, reserveMin: Number($("reserveMin").value), ...(cutEpisode ? { cut: cutEpisode } : {}) });
    sessionId = s.sessionId;
    $("sessionLabel").textContent = `Session ${sessionId} · ${windowMin} min window · transcript ${s.transcriptSaved ? "saved" : "memory-only"}`;
    $("capture").hidden = false;
    $("setup").querySelector("button").disabled = true;
    startPolling();
  } catch (e) { alert(e.message); }
});

function startPolling() {
  stopPolling();
  const tick = async () => {
    if (!sessionId) return;
    try {
      const s = await api(`/api/humain/sessions/${sessionId}`);
      render(s);
    } catch (e) { /* session over or server away; keep last render */ }
  };
  pollTimer = setInterval(tick, 1000);
  tick();
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

function render(s) {
  lastState = s;
  $("phase").textContent = s.phase;
  $("phase").className = "pill" + (s.inputClosed ? " closed" : "");
  $("recpill").hidden = !s.recording;
  $("timer").textContent = s.inputClosed ? "input closed" : mmss(s.inputRemainingMs);
  $("timer").classList.toggle("danger", !s.inputClosed && s.inputRemainingMs < 60_000);
  const canRecord = s.phase === "listening";
  $("record").disabled = !canRecord || s.recording;
  $("stopRec").disabled = !s.recording;
  $("doneSpeaking").disabled = s.phase !== "listening";
  if (s.inputClosed) {
    // The deadline (or the user) closed input: stop everything locally, never restart.
    stopLocalCapture("input closed");
    $("planCard").hidden = false;
  }
  if (s.plan) {
    $("planCard").hidden = false;
    $("hook").innerHTML = `<strong>Hook:</strong> ${escapeHtml(s.plan.hook)} <span class="muted">(planner: ${escapeHtml(s.plan.planner)})</span>`;
    $("tasks").querySelector("tbody").innerHTML = s.plan.tasks.map((t) => `<tr><td>${escapeHtml(t.title)}</td><td>${t.kind}</td><td>${escapeHtml(t.capability)}</td><td>$${t.estApiUsd} · ${t.estHours}h · ${t.estSeconds}s</td><td>${t.decision ? escapeHtml(t.decision) : "&mdash;"}${s.decisions[t.taskId] ? `<br><em>resolved: ${escapeHtml(s.decisions[t.taskId])}</em>` : ""}</td></tr>`).join("");
  }
  if (s.capabilities) {
    $("reuse").innerHTML = s.capabilities.reuse.map((r) => `<li><strong>${escapeHtml(r.capability)}</strong> &mdash; ${escapeHtml(r.source)} (${escapeHtml(r.evidence)})</li>`).join("");
    $("build").innerHTML = s.capabilities.build.map((b) => `<li><strong>${escapeHtml(b.capability)}</strong> &mdash; ${escapeHtml(b.why)}</li>`).join("");
  }
  if (s.estimate) {
    $("estimate").textContent = `$${s.estimate.apiUsd} API · ${s.estimate.localHours}h local · ${s.estimate.executionSeconds}s execution (forecast ${s.estimate.forecastId})`;
    $("approveCard").hidden = false;
  }
  if (s.contract) {
    const c = s.contract;
    $("contract").innerHTML =
      `<p><strong>Desired:</strong> ${escapeHtml(c.desired)}</p>` +
      `<p><strong>Observed:</strong></p><ul>${c.observed.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul>` +
      `<p><strong>Already satisfied:</strong> ${c.satisfied.length ? "" : "&mdash; (delta is real work)"}</p><ul>${c.satisfied.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul>` +
      `<p><strong>Required modifications:</strong></p><ul>${c.modifications.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul>` +
      `<p><strong>Missing capabilities:</strong> ${c.missing.map(escapeHtml).join("; ") || "&mdash;"}</p>` +
      `<p><strong>Acceptance (${c.acceptance.length}):</strong></p><ul>${c.acceptance.map((a) => `<li>${a.id}: ${escapeHtml(a.description)}</li>`).join("")}</ul>` +
      `<p><strong>Limits:</strong> ceiling ${c.limits.spendCeilingUsd === null ? "unset" : "$" + c.limits.spendCeilingUsd} · compute ${c.limits.computeDeadlineSecs === null ? "unset" : c.limits.computeDeadlineSecs + "s"}</p>`;
  }
  if (s.cut && s.plan) {
    const key = `${s.plan.tasks.length}/${s.results.length}/${s.terminal ? s.terminal.reason : ""}`;
    if (key !== lastRevKey) { lastRevKey = key; loadRevision(); }
  }
  if (s.frames && s.frames.length) loadFrames();
  if (s.approval) {
    $("approveCard").querySelector("button").disabled = true;
    $("execCard").hidden = false;
  }
  if (s.results.length) {
    $("results").querySelector("tbody").innerHTML = s.results.map((r) => `<tr><td>${escapeHtml(r.taskId)}</td><td>${r.status}</td><td>${escapeHtml(r.evidence || r.detail)}</td><td>${r.costUsd === null ? "unknown" : "$" + r.costUsd}</td></tr>`).join("");
  }
  if (s.artifacts.length) {
    const a = s.artifacts[s.artifacts.length - 1];
    $("artifact").innerHTML = `Artifact: <a href="/api/humain/sessions/${sessionId}/artifact" target="_blank">${escapeHtml(a.label)}</a> <span class="muted">sha256 ${a.sha256.slice(0, 12)} · ${a.bytes} bytes</span>`;
  }
  if (s.terminal) {
    stopLocalCapture("session over");
    stopPolling();
    let ledger = `<strong>Session ${s.terminal.reason}:</strong> ${escapeHtml(s.terminal.detail)} Actual API spend: $${s.spendUsd}.`;
    if (s.accounting) ledger += `<br>Time: human used ${s.accounting.humanUsedSecs}s of ${s.accounting.reserveMin * 60}s reserved (${s.accounting.humanReleasedSecs}s released) · autonomous ${s.accounting.autonomousSecs}s · daily budget ${s.accounting.humanBudgetMin} min.`;
    $("ledgerLine").innerHTML = ledger;
    loadReplay();
    $("replayCard").hidden = false;
  }
}

async function loadFrames() {
  try {
    const frames = await api("/api/humain/frames");
    const totals = await api("/api/humain/frames/totals").catch(() => null);
    const rows = frames.map((f) => `<tr><td><a href="/api/humain/frames/${f.frameId}" target="_blank">${f.frameId}</a></td><td>${escapeHtml(f.hook)}</td><td>${escapeHtml(f.workA)} vs ${escapeHtml(f.workB)}</td><td>${f.counts.human}</td><td>${f.counts.unique}</td><td>${f.counts.verification}</td></tr>`);
    if (totals) rows.push(`<tr><td colspan="3"><strong>Totals (${totals.frames} frames)</strong></td><td><strong>${totals.human}</strong></td><td><strong>${totals.unique}</strong></td><td><strong>${totals.verification}</strong></td></tr>`);
    $("frames").querySelector("tbody").innerHTML = rows.length ? rows.join("") : `<tr><td colspan="6" class="muted">None yet.</td></tr>`;
  } catch (e) {}
}
$("refreshFrames").addEventListener("click", loadFrames);
loadFrames();

async function loadRevision() {
  if (!sessionId) return;
  try {
    const r = await api(`/api/humain/sessions/${sessionId}/revision`);
    $("reviseCard").hidden = false;
    $("reuseLine").innerHTML = `<span class="reuse">${escapeHtml(r.reuseLine)}</span> <span class="muted">take ${r.take} &rarr; ${r.nextTake}</span>`;
    $("editRows").innerHTML = "<ul>" + r.edits.map((e) => `<li><span class="op">${escapeHtml(e.op)}</span> &middot; ${escapeHtml(e.target)} &middot; ${escapeHtml(e.why)} <span class="muted">(${escapeHtml(e.fixes)})</span></li>`).join("") + "</ul>";
    $("acceptRows").innerHTML = "<ul>" + r.acceptance.map((a) => `<li><span class="${a.pass ? "pass" : "fail"}">${a.pass ? "✓" : "✗"}</span> ${escapeHtml(a.description)} <span class="muted">${escapeHtml(a.detail || "")}</span></li>`).join("") + "</ul>";
  } catch (e) { /* revision not ready yet; next render retries on change */ }
}

async function loadReplay() {
  const events = await api(`/api/humain/sessions/${sessionId}/events`);
  $("events").innerHTML = events.map((e) => `<div>${e.seq} ${e.id} <strong>${e.type}</strong> ${escapeHtml(JSON.stringify(e.payload).slice(0, 160))}</div>`).join("");
}

function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// ---------------- capture: explicit start, deadline stop, never auto-restart

$("record").addEventListener("click", async () => {
  if (!sessionId) return;
  try {
    await api(`/api/humain/sessions/${sessionId}/recording/start`, "POST", { reason: "user pressed record" });
  } catch (e) { alert(e.message); return; }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert("Microphone unavailable; use the typed fallback below. (" + e.message + ")");
    await api(`/api/humain/sessions/${sessionId}/recording/stop`, "POST", { reason: "mic unavailable" }).catch(() => {});
    return;
  }
  // With Meta Voice checked, chunks are kept for one upload on stop; otherwise
  // they are discarded: audio proves nothing and is stored nowhere.
  const metaVoice = $("metaVoice").checked;
  audioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (ev) => { if (metaVoice && ev.data && ev.data.size) audioChunks.push(ev.data); };
  mediaRecorder.start(1000);
  if (metaVoice) {
    $("transcript").innerHTML = `<span class="muted">Recording for Meta Voice Transcribe — audio uploads once when you stop. On-device recognition is off for this take.</span>`;
  } else {
    startRecognition();
  }
  const s = await api(`/api/humain/sessions/${sessionId}`);
  render(s);
});

$("stopRec").addEventListener("click", async () => {
  const chunks = audioChunks;
  audioChunks = [];
  stopLocalCapture("user stopped recording");
  if (sessionId) {
    const s = await api(`/api/humain/sessions/${sessionId}/recording/stop`, "POST", { reason: "user stopped recording" }).catch(() => null);
    if (s) render(s);
  }
  // Meta Voice path: exactly one upload per take. Failures are shown, never
  // swapped for another transcriber behind the user's back.
  if ($("metaVoice").checked && chunks.length && sessionId) {
    $("transcript").innerHTML = `<span class="muted">Uploading ${chunks.length} audio chunk(s) to Meta Voice Transcribe…</span>`;
    try {
      const wav = await chunksToWav16kMono(chunks);
      const r = await api(`/api/humain/sessions/${sessionId}/audio`, "POST", { audioBase64: wav, mime: "audio/wav" });
      $("transcript").innerHTML = `<span class="muted">Meta Voice Transcribe returned ${r.chunks} chunk(s). Speak more or press “Done speaking”.</span>`;
      render(r.state);
    } catch (e) {
      $("transcript").innerHTML = `<span>Meta Voice Transcribe failed visibly: ${escapeHtml(e.message)}. Nothing was substituted — fix the server key or uncheck the box and record again.</span>`;
    }
  }
});

// Decode recorded chunks and re-encode as 16 kHz mono 16-bit WAV (base64),
// the shape the server's Meta Voice adapter accepts.
async function chunksToWav16kMono(chunks) {
  const buf = await new Blob(chunks).arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(buf);
    const rate = 16000;
    const len = Math.floor(decoded.duration * rate);
    const off = new OfflineAudioContext(1, len, rate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const pcm = rendered.getChannelData(0);
    const wav = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(wav);
    const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); wstr(8, "WAVE"); wstr(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    wstr(36, "data"); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    const bytes = new Uint8Array(wav);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(bin);
  } finally {
    try { await ctx.close(); } catch (e) {}
  }
}

function startRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $("transcript").innerHTML = `<span class="muted">No on-device speech recognition in this browser; use the typed fallback below.</span>`;
    return;
  }
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = async (ev) => {
    let interim = "", finals = [];
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finals.push(r[0].transcript);
      else interim += r[0].transcript;
    }
    const show = [...finals, interim].join(" ").trim();
    if (show) $("transcript").textContent = show;
    for (const text of finals) {
      try {
        const r = await api(`/api/humain/sessions/${sessionId}/transcript`, "POST", { text, final: true, source: "browser-speech/offline" });
        render(r.state);
      } catch (e) {
        // Most likely the input window closed mid-sentence: stop, don't retry.
        stopLocalCapture("transcript rejected: " + e.message);
        const s = await api(`/api/humain/sessions/${sessionId}`).catch(() => null);
        if (s) render(s);
      }
    }
  };
  recognition.onerror = () => {};
  recognition.onend = () => {
    // Never silently restart. If the server still shows recording and input open,
    // the user presses record again explicitly.
    recognition = null;
  };
  try { recognition.start(); } catch (e) {}
}

function stopLocalCapture(_why) {
  try { if (recognition) recognition.stop(); } catch (e) {}
  recognition = null;
  try { if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); } catch (e) {}
  mediaRecorder = null;
  if (mediaStream) for (const t of mediaStream.getTracks()) t.stop();
  mediaStream = null;
}

$("sendTyped").addEventListener("click", async () => {
  const text = $("typed").value.trim();
  if (!text || !sessionId) return;
  try {
    const r = await api(`/api/humain/sessions/${sessionId}/transcript`, "POST", { text, final: true, source: "typed-fallback" });
    $("transcript").textContent = (($("transcript").textContent || "") + " " + text).trim();
    $("typed").value = "";
    render(r.state);
  } catch (e) { alert(e.message); }
});

$("doneSpeaking").addEventListener("click", async () => {
  stopLocalCapture("user finished speaking");
  try {
    const s = await api(`/api/humain/sessions/${sessionId}/input/close`, "POST", { reason: "user finished speaking" });
    render(s);
  } catch (e) { alert(e.message); }
});

$("makePlan").addEventListener("click", async () => {
  try {
    const s = await api(`/api/humain/sessions/${sessionId}/plan`, "POST", {});
    render(s);
  } catch (e) { alert(e.message); }
});

$("approve").addEventListener("click", async () => {
  try {
    const s = await api(`/api/humain/sessions/${sessionId}/approve`, "POST", {
      spendCeilingUsd: Number($("ceiling").value),
      computeDeadlineSecs: Number($("computeSecs").value),
    });
    render(s);
  } catch (e) { alert(e.message); }
});

$("execute").addEventListener("click", async () => {
  try {
    const s = await api(`/api/humain/sessions/${sessionId}/execute`, "POST", {});
    render(s);
  } catch (e) { alert(e.message); }
});

$("stop").addEventListener("click", async () => {
  const revoke = confirm("OK = stop.\nCancel = revoke (stronger: same halt, recorded as revoked).");
  stopLocalCapture("user stop");
  try {
    const s = await api(`/api/humain/sessions/${sessionId}/stop`, "POST", { revoke: !revoke ? true : false, reason: "user pressed stop" });
    render(s);
  } catch (e) { alert(e.message); }
});
