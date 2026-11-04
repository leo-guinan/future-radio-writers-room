// The Art Bus Workshop page. Reads the workshop API; writes need X sign-in.
const $ = (id) => document.getElementById(id);
let closesAtMs = 0;
let myVotes = {};
let signedIn = null;

async function api(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.code || `HTTP ${res.status}`);
  return data;
}

function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function pad(n) { return String(n).padStart(2, "0"); }

function tickCountdown() {
  const left = closesAtMs - Date.now();
  const el = $("countdown");
  if (left <= 0) {
    el.textContent = "WORKSHOP CLOSED";
    el.classList.add("closed");
    return;
  }
  const s = Math.floor(left / 1000);
  el.textContent = `${Math.floor(s / 86400)}d ${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

async function loadStatus() {
  const st = await api("/api/workshop");
  closesAtMs = Date.parse(st.closesAt);
  $("windowLine").textContent = `Open since ${st.opensAt} · closes ${st.closesAt} · chain head ${st.head.slice(0, 12)} · seq ${st.seq}`;
  $("counts").textContent = `${st.counts.players} players · ${st.counts.ideas} ideas · ${st.counts.votePoints} vote points · ${st.counts.builds} builds · ${st.counts.nodes} nodes`;
  $("pledge").textContent = st.pledge.text;
  tickCountdown();
  const rw = await api("/api/workshop/rewards").catch(() => null);
  if (rw) {
    $("rewardsLine").textContent = rw.status === "projected"
      ? `Projected split · prize ${rw.prizeOutcome} · operator share: ${rw.operatorShareNote}`
      : `Final split · prize ${rw.prizeOutcome} · operator share: ${rw.operatorShareNote}`;
  }
}

async function loadMe() {
  try {
    const me = await api("/api/workshop/me");
    signedIn = me;
    myVotes = me.votes || {};
    $("signinArea").innerHTML = `Signed in as <strong>${esc(me.handle)}</strong>`;
  } catch (e) {
    signedIn = null;
    myVotes = {};
  }
}

function budgetLeft() {
  let used = 0;
  for (const v of document.querySelectorAll(".voteSlider")) used += Number(v.value);
  return 10 - used;
}

function paintBudget() {
  const left = budgetLeft();
  const el = $("budget");
  el.textContent = `${left} / 10 left`;
  el.classList.toggle("over", left < 0);
}

async function loadIdeas() {
  const ideas = await api("/api/workshop/ideas?sort=votes");
  $("ideas").querySelector("tbody").innerHTML = ideas.map((i) => {
    const mine = myVotes[i.id] ?? 0;
    return `<tr><td><strong>${esc(i.title)}</strong><br><span class="muted">${esc(i.pitch)} · incentive: ${esc(i.incentive)}</span>${i.built ? `<br><span class="muted">BUILT: <a href="${esc(i.built.url)}" target="_blank">${esc(i.built.url)}</a></span>` : ""}</td>` +
      `<td>${esc(i.kind)}</td><td>${esc(i.authorHandle)}</td><td>${i.votes}</td>` +
      `<td><input type="range" class="voteSlider" data-idea="${esc(i.id)}" min="0" max="5" step="1" value="${mine}"> <span id="v-${esc(i.id)}">${mine}</span></td></tr>`;
  }).join("") || `<tr><td colspan="5" class="muted">No ideas yet — request the first.</td></tr>`;
  for (const s of document.querySelectorAll(".voteSlider")) {
    s.addEventListener("input", () => {
      $(`v-${s.dataset.idea}`).textContent = s.value;
      paintBudget();
    });
  }
  paintBudget();
}

async function loadScoreboard() {
  const board = await api("/api/workshop/scoreboard");
  $("scoreboard").querySelector("tbody").innerHTML = board.map((r) =>
    `<tr><td><strong>${r.points}</strong></td><td>${esc(r.handle)}</td><td>${r.breakdown.ideas}</td><td>${r.breakdown.votes}</td><td>${r.breakdown.builds}</td><td>${r.breakdown.uptime}</td><td>${r.newAccount ? '<span class="flag">new_account</span>' : ""}</td></tr>`
  ).join("") || `<tr><td colspan="7" class="muted">Nobody scored yet.</td></tr>`;
}

async function loadNodes() {
  const nodes = await api("/api/workshop/nodes");
  $("nodes").querySelector("tbody").innerHTML = nodes.map((n) =>
    `<tr><td>${esc(n.nodeId)}</td><td>${esc(n.operatorHandle)}</td><td>${n.up ? "yes" : "no"}</td><td>${n.upHours} (${n.upMinutes}m)</td><td>${esc(n.lastHeartbeat || "—")}</td></tr>`
  ).join("") || `<tr><td colspan="5" class="muted">No nodes yet.</td></tr>`;
}

$("submitIdea").addEventListener("click", async () => {
  const msg = $("ideaMsg");
  msg.className = "";
  try {
    const r = await api("/api/workshop/ideas", "POST", { kind: $("kind").value, title: $("title").value, pitch: $("pitch").value, incentive: $("incentive").value });
    msg.className = "ok";
    msg.textContent = `Submitted ${r.id}.`;
    $("title").value = $("pitch").value = $("incentive").value = "";
    await refresh();
  } catch (e) {
    msg.className = "err";
    msg.textContent = e.message;
  }
});

$("saveVotes").addEventListener("click", async () => {
  const msg = $("voteMsg");
  msg.className = "";
  const allocation = {};
  for (const s of document.querySelectorAll(".voteSlider")) allocation[s.dataset.idea] = Number(s.value);
  try {
    await api("/api/workshop/votes", "PUT", allocation);
    myVotes = allocation;
    msg.className = "ok";
    msg.textContent = "Votes saved.";
    await refresh();
  } catch (e) {
    msg.className = "err";
    msg.textContent = e.message;
  }
});

async function refresh() {
  try {
    await loadStatus();
    await loadIdeas();
    await loadScoreboard();
    await loadNodes();
  } catch (e) { /* server away; keep last render */ }
}

(async () => {
  await loadMe();
  await refresh();
  setInterval(tickCountdown, 1000);
  setInterval(refresh, 15000);
})();
