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
let lastState = null;

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
    const s = await api("/api/humain/sessions", "POST", { inputWindowMin: windowMin, saveTranscript: $("saveTranscript").checked });
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
    $("ledgerLine").innerHTML = `<strong>Session ${s.terminal.reason}:</strong> ${escapeHtml(s.terminal.detail)} Actual API spend: $${s.spendUsd}.`;
    loadReplay();
    $("replayCard").hidden = false;
  }
}

async function loadFrames() {
  try {
    const frames = await api("/api/humain/frames");
    $("frames").querySelector("tbody").innerHTML = frames.length
      ? frames.map((f) => `<tr><td><a href="/api/humain/frames/${f.frameId}" target="_blank">${f.frameId}</a></td><td>${escapeHtml(f.hook)}</td><td>${escapeHtml(f.workA)} vs ${escapeHtml(f.workB)}</td><td>${f.visits}</td></tr>`).join("")
      : `<tr><td colspan="4" class="muted">None yet.</td></tr>`;
  } catch (e) {}
}
$("refreshFrames").addEventListener("click", loadFrames);
loadFrames();

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
  // Chunks are discarded: audio proves nothing and is stored nowhere.
  mediaRecorder = new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = () => {};
  mediaRecorder.start(1000);
  startRecognition();
  const s = await api(`/api/humain/sessions/${sessionId}`);
  render(s);
});

$("stopRec").addEventListener("click", async () => {
  stopLocalCapture("user stopped recording");
  if (sessionId) {
    const s = await api(`/api/humain/sessions/${sessionId}/recording/stop`, "POST", { reason: "user stopped recording" }).catch(() => null);
    if (s) render(s);
  }
});

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
