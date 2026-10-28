// The workshop page. Plain JS, no build step.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (n) => `$${(n ?? 0).toFixed(2)}`;
const STAGES = ["planned", "select", "write", "generate", "review", "publish", "account"];
// Roles are the system; characters are this show's casting (cast.json). Colours follow the role.
const ROLE_VERBS = { memory: ["remembers", "to remember"], making: ["creates", "to sketch"], accounting: ["keeps the score", "to score"] };
const NAMES = { showrunner: "Showrunner" };
const nameOf = (slug) => NAMES[slug] || (slug ? slug[0].toUpperCase() + slug.slice(1).replace(/-/g, " ") : "");
const roleOf = (slug) => Object.keys(snap?.roles || {}).find((r) => snap.roles[r] === slug);
let snap = null;
const seen = new Set();

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function renderTagline() {
  const el = $("#tagline");
  if (!el || !snap?.roles) return;
  el.innerHTML = Object.entries(snap.roles)
    .map(([role, slug]) => `<b class="c-${esc(role)}">${esc(nameOf(slug))}</b> ${esc(ROLE_VERBS[role]?.[0] || role)}.`)
    .join(" ");
  const screen = $("#screen-h");
  if (screen) screen.textContent = `${nameOf(snap.roles.accounting)}'s screen`;
}

// ------------------------------------------------------------ snapshot

async function refresh() {
  snap = await api("/api/room");
  renderTagline();
  $("#head").textContent = snap.head.slice(0, 16) + "…";
  $("#seq").textContent = `${snap.seq} events`;
  renderSeason();
  renderScore();
  renderBoard();
  renderCast();
  renderExtras();
  const sel = $("#ep-select");
  if (sel.options.length === 1)
    for (const e of snap.episodes) if (!e.releases.length) sel.add(new Option(`${e.number}. ${e.title}`, e.episodeId));
}
let refreshTimer;
const refreshSoon = () => (clearTimeout(refreshTimer), (refreshTimer = setTimeout(refresh, 400)));

function renderSeason() {
  const eps = [...snap.episodes].sort((a, b) => a.number - b.number);
  $("#season").innerHTML = eps
    .map((e) => {
      const pct = Math.round((STAGES.indexOf(e.stage) / (STAGES.length - 1)) * 100);
      const released = e.releases.length > 0;
      const active = !released && e.stage !== "planned";
      return `<li><button class="ep ${released ? "released" : ""} ${active ? "active" : ""}" data-ep="${esc(e.episodeId)}">
        <span class="n">${e.number}</span>
        <span class="t">${esc(e.title)}</span>
        <span class="bar"><i style="width:${pct}%"></i></span>
        <span class="st">${released ? `released ${esc(e.releases.at(-1).version)}` : esc(e.stage)}</span>
      </button></li>`;
    })
    .join("");
}

function renderScore() {
  const s = snap.scorecard;
  const o = s.operations;
  const hours = Object.entries(s.effort.hoursBy);
  const open = s.forecasts.filter((f) => f.outcome === "open");
  $("#score").innerHTML = `
    <div class="quad">
      <div class="cell observed"><div class="k">Observed</div><div class="v">${usd(o.observed.contribution)}</div><div class="s">${usd(o.observed.receipts)} in · ${usd(o.observed.expenses)} out</div></div>
      <div class="cell projected"><div class="k">Projected</div><div class="v">${usd(o.projected.receipts - o.projected.expenses)}</div><div class="s">not booked as cash</div></div>
      <div class="cell disputed"><div class="k">Disputed</div><div class="v">${usd(o.disputed.receipts - o.disputed.expenses)}</div><div class="s">under review</div></div>
      <div class="cell"><div class="k">Unknown</div><div class="v">${o.unknownItems}</div><div class="s">${o.unpricedTokens ? `${o.unpricedTokens.toLocaleString()} unpriced tokens` : "items without a price"}</div></div>
    </div>
    <ul class="lines">
      <li><span>Human hours</span><span>${hours.length ? hours.map(([w, h]) => `${esc(w)} ${h}h`).join(" · ") : "none recorded yet"}</span></li>
      <li><span>Historical investment</span><span>${usd(s.historical.expenses)} (separate ledger)</span></li>
      ${open.map((f) => `<li><span>${esc(f.claim)}</span><span class="tag">due ${esc(f.dueBy.slice(5))}</span></li>`).join("")}
      ${s.forecasts.filter((f) => f.outcome !== "open").map((f) => `<li><span>${esc(f.claim)}</span><span class="tag">${esc(f.outcome)}</span></li>`).join("")}
    </ul>`;
}

function renderBoard() {
  const order = ["proposed", "explored", "compared", "selected", "produced", "measured", "deferred", "merged", "declined"];
  const groups = order.map((st) => [st, snap.board.filter((i) => i.status === st)]).filter(([, l]) => l.length);
  $("#board").innerHTML = groups.length
    ? groups
        .map(
          ([st, list]) => `<div class="status-group">${esc(st)} · ${list.length}</div>` +
            list
              .map(
                (i) => `<button class="idea" data-idea="${esc(i.ideaId)}">
                  <span><span class="me">${esc(i.ideaId)} · ${esc(i.output)}${i.episodeId ? ` · ${esc(i.episodeId)}` : ""}</span><br><span class="ti">${esc(i.title)}</span></span>
                  <span class="sig"><span title="creative judgment (0–3)">${i.creative === null ? "–" : i.creative.toFixed(1)}</span><span title="community votes">${i.community}</span><span title="patron support received">${i.financial ? usd(i.financial) : "–"}</span></span>
                </button>`,
              )
              .join(""),
        )
        .join("")
    : `<p class="empty">No ideas yet. Be the first.</p>`;
}

// ------------------------------------------------------------ cast

async function renderCast() {
  const cast = await api("/api/cast").catch(() => []);
  for (const c of cast) NAMES[c.character] = c.name;
  renderTagline();
  $("#cast").innerHTML = cast
    .map((c) => `<article class="member ${esc(c.character)} ${esc(roleOf(c.character) || "")}">
      <h3>${esc(c.name)}</h3>
      <p class="intro">${esc(c.intro)}</p>
      ${c.voice ? `<blockquote>${esc(c.voice)}</blockquote>` : ""}
      <p class="stats">${c.runs} run${c.runs === 1 ? "" : "s"}${c.lastSeen ? ` · last seen ${esc(c.lastSeen)}` : ""}${c.episodes.length ? ` · ${esc(c.episodes.join(", "))}` : ""} · ${c.canon + c.viewerNotes.length} canon note${c.canon + c.viewerNotes.length === 1 ? "" : "s"}${c.viewerNotes.length ? `, ${c.viewerNotes.length} from viewers` : ""}</p>
      ${c.viewerNotes.length ? `<ul class="vnotes">${c.viewerNotes.slice(-2).map((v) => `<li>${esc(v.note)} <span class="muted">— ${esc(v.from)}</span></li>`).join("")}</ul>` : ""}
      ${c.talk ? `<p class="talk"><a class="link" href="${esc(c.talk)}" target="_blank" rel="noopener">Talk with ${esc(c.name)} →</a> <span class="muted">voice call, in their own voice</span></p>` : ""}
      <p class="links">${
        c.links
          ? `<a class="link" href="${esc(c.links.bible)}" target="_blank" rel="noopener">Read the bible</a> · <a class="link" href="${esc(c.links.contribute)}" target="_blank" rel="noopener">Propose a change</a> · <a class="link" href="${esc(c.links.note)}" target="_blank" rel="noopener">Leave a viewer note</a>`
          : `<span class="muted">Dressing room <code>${esc(c.repo)}@${esc(c.head.slice(0, 7))}</code> — on GitHub soon, open to pull requests.</span>`
      }</p>
    </article>`)
    .join("");
}

async function renderExtras() {
  const extras = await api("/api/extras").catch(() => []);
  $("#extras").innerHTML = extras.length
    ? extras
        .map(
          (x) => `<article class="extra">
      <h4>${esc(x.name)}${x.worthConsidering ? ` <span class="tag" title="Enough appearances and interest to consider a dressing room">rising</span>` : ""}</h4>
      <p>${esc(x.intro)}</p>
      <p class="stats">${x.appearances.length ? `in ${esc(x.appearances.join(", "))}` : "not in a released episode yet"} · ${x.openQuestions} open question${x.openQuestions === 1 ? "" : "s"}${x.viewerNotes ? ` · ${x.viewerNotes} viewer note${x.viewerNotes === 1 ? "" : "s"}` : ""}${x.votes ? ` · ${x.votes} vote${x.votes === 1 ? "" : "s"}` : ""}</p>
      ${x.links ? `<p class="links"><a class="link" href="${esc(x.links.folder)}" target="_blank" rel="noopener">What we know</a> · <a class="link" href="${esc(x.links.note)}" target="_blank" rel="noopener">Tell us something</a></p>` : ""}
    </article>`,
        )
        .join("")
    : `<p class="empty">No extras yet.</p>`;
}

// ------------------------------------------------------------ feed

function who(e) {
  if (e.type === "agent.run") return e.payload.character;
  if (e.actor.startsWith("patron")) return "patron";
  if (e.actor === "showrunner") return "showrunner";
  return "";
}

function line(e) {
  const p = e.payload;
  const ideaLink = (id) => `<a class="link" data-idea="${esc(id)}">${esc(id)}</a>`;
  const epLink = (id) => `<a class="link" data-ep="${esc(id)}">${esc(id)}</a>`;
  const actor = e.actor.startsWith("patron:") ? e.actor.slice(7) : e.actor;
  switch (e.type) {
    case "room.rules_locked": return [`room`, `The rules of the room were locked: ${p.rules.length} rules, starting with "${esc(p.rules[0])}"`];
    case "idea.proposed": return [actor, `proposed ${ideaLink(p.ideaId)} <b>${esc(p.title)}</b> — <i>${esc(p.question)}</i>`];
    case "idea.transitioned": return [actor, `moved ${ideaLink(p.ideaId)} from ${esc(p.from)} to <b>${esc(p.to)}</b>. ${esc(p.reason)}`];
    case "idea.signal": return [actor, `${p.kind === "community" ? "voted for" : `gave a ${esc(p.kind)} signal to`} ${ideaLink(p.ideaId)}`];
    case "idea.note": return [actor, `noted on ${ideaLink(p.ideaId)}: ${esc(p.text)}`];
    case "episode.planned": return [actor, `planned ${epLink(p.episodeId)} <b>${esc(p.title)}</b> · ceiling ${usd(p.budget.cashCeiling)}`];
    case "episode.stage": return [actor, `${epLink(p.episodeId)} entered <b>${esc(p.stage)}</b>${p.note ? ` — ${esc(p.note)}` : ""}`];
    case "episode.scene_added": return [actor, `added scene ${esc(p.sceneId)} <b>${esc(p.title)}</b> to ${epLink(p.episodeId)}`];
    case "episode.scene_selected": return [actor, `${p.selected ? "kept" : "cut"} scene ${esc(p.sceneId)} — ${esc(p.reason)}`];
    case "episode.asset_added": return [actor, `added ${esc(p.kind)} "${esc(p.label)}" to ${epLink(p.episodeId)}`];
    case "episode.released": return [actor, `<b>released ${epLink(p.episodeId)} ${esc(p.version)}</b> and locked it (sha256 <code>${esc(p.sha256.slice(0, 12))}</code>). ${esc(p.invitation)}`];
    case "budget.authorized": return [actor, `raised ${epLink(p.episodeId)}'s ceiling to ${usd(p.newCeiling)}: ${esc(p.reason)}`];
    case "ledger.entry": return [actor, `${esc(p.ledger)} ledger: ${esc(p.kind)} ${p.unit === "usd" ? usd(p.amount) : `${p.amount} ${esc(p.unit)}`} <span class="tag">${esc(p.status)}</span> ${esc(p.label)}`];
    case "forecast.recorded": return [actor, `recorded a forecast, due ${esc(p.dueBy)}: <i>${esc(p.claim)}</i>`];
    case "forecast.resolved": return [actor, `resolved ${esc(p.forecastId)} as <b>${esc(p.outcome)}</b>: ${esc(p.observation)}`];
    case "showrunner.tick": {
      const held = p.held.length ? ` Held ${p.held.length}: ${p.held.slice(0, 4).map((h) => `${ideaLink(h.ideaId)} (${esc(h.failed.map((f) => f.gate).join(", "))})`).join(", ")}${p.held.length > 4 ? "…" : ""}.` : "";
      return [actor, `made rounds on ${epLink(p.episodeId)}: ${p.load} open, ${p.activeGates.length} gates on${p.cut.length ? `, <b>cut ${p.cut.map(ideaLink).join(", ")}</b>` : ""}${p.queued.length ? `, ${p.queued.length} queued` : ""}.${held}`];
    }
    case "idea.cut": return [actor, `assembled a <b>first cut</b> of ${ideaLink(p.ideaId)} in <code>${esc(p.repo)}@${esc(p.sha.slice(0, 7))}</code> — ${esc(p.approach)}`];
    case "repo.commit": return [actor, `committed to <code>${esc(p.repo)}@${esc(p.sha.slice(0, 7))}</code>: ${esc(p.message)}`];
    case "conference.held": return [actor, `held the <b>${esc(p.kind)}</b> press conference "${esc(p.title)}"`];
    default: return [actor, esc(e.type)];
  }
}

function runBody(p) {
  const voice = String(p.text || "").split(/\n{2,}/).map((x) => `<p>${esc(x)}</p>`).join("");
  let extra = "";
  const o = p.output || {};
  const role = p.role || roleOf(p.character);
  if (role === "making" && o.approaches)
    extra = `<ol class="approaches">${o.approaches.map((a) => `<li><b>${esc(a.title)}</b> — ${esc(a.deliverable)} · ~${usd(a.estCashUsd)} · ~${esc(a.estHours)}h · <i>stop: ${esc(a.stoppingRule)}</i></li>`).join("")}</ol>`;
  if (p.character === "showrunner") extra = "";
  if (role === "accounting" && o.scores)
    extra = `<div class="scores"><span>story <b>${o.scores.story}</b>/3</span><span>business <b>${o.scores.business}</b>/3</span><span>participation <b>${o.scores.participation}</b>/3</span><span>→ <b>${esc(o.recommend)}</b></span>${o.budget ? `<span>remaining ${usd(o.budget.remaining)}</span>` : ""}</div>`;
  const flags = p.flags?.length ? `<div class="flags">⚑ ${p.flags.map(esc).join(" · ")}</div>` : "";
  return `<div class="voice">${voice}</div>${extra}${flags}`;
}

function feedItem(e) {
  const t = new Date(e.ts);
  const time = `${t.toLocaleDateString([], { month: "short", day: "numeric" })} <br>${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  if (e.type === "agent.run") {
    const p = e.payload;
    const asked = p.askedBy.startsWith("patron:") ? `asked by ${esc(p.askedBy.slice(7))}` : `for ${esc(p.askedBy)}`;
    const target = p.ideaId ? ` on <a class="link" data-idea="${esc(p.ideaId)}">${esc(p.ideaId)}</a>` : "";
    return `<li class="${esc(p.character)} ${esc(p.role || roleOf(p.character) || "")}"><time>${time}</time><div><div class="who">${esc(nameOf(p.character))} · ${asked}${target}${p.offline ? " · offline" : ""}</div>${runBody(p)}</div></li>`;
  }
  const [actor, what] = line(e);
  return `<li class="${who(e)}"><time>${time}</time><div><div class="who">${esc(actor)}</div><p class="what">${what}</p></div></li>`;
}

function addToFeed(events, prepend = true) {
  const feed = $("#feed");
  const fresh = events.filter((e) => e && !seen.has(e.id) && !(e.type === "repo.commit" && e.actor !== "showrunner") && !(e.type === "repo.commit" && /^First cut/.test(e.payload.message)));
  fresh.forEach((e) => seen.add(e.id));
  const html = fresh.map(feedItem).reverse().join("");
  if (prepend) feed.insertAdjacentHTML("afterbegin", html);
  else feed.innerHTML = html || `<li class="empty">The workshop is quiet.</li>`;
  while (feed.children.length > 200) feed.lastElementChild.remove();
}

function connect() {
  const es = new EventSource("/api/stream");
  es.onopen = () => $("#onair").classList.remove("off");
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    addToFeed([e]);
    refreshSoon();
  };
  es.onerror = () => $("#onair").classList.add("off");
}

// ------------------------------------------------------------ drawers

const drawer = $("#drawer");
const open = (html) => {
  $("#drawer-body").innerHTML = html;
  if (!drawer.open) drawer.showModal();
};

async function showEpisode(id) {
  const e = await api(`/api/episodes/${encodeURIComponent(id)}`);
  const scenes = [...e.scenes].sort((a, b) => a.sceneId.localeCompare(b.sceneId));
  const sel = scenes.filter((s) => s.selected);
  open(`
    <p class="kicker">Episode ${e.number} · ${esc(e.stage)}</p>
    <h2 id="drawer-title">${esc(e.title)}</h2>
    <p>${esc(e.logline)}</p>
    <dl class="dl">
      <dt>Budget</dt><dd>${usd(e.cash)} spent of ${usd(e.ceiling)} ceiling · ${e.hours}h recorded</dd>
      <dt>Runtime</dt><dd>${e.budget.runtimeMinutes[0]}–${e.budget.runtimeMinutes[1]} min${sel.length ? ` · selected scenes estimate ${sel.reduce((t, s) => t + s.minutes[0], 0)}–${sel.reduce((t, s) => t + s.minutes[1], 0)} min` : ""}</dd>
      ${e.deadline ? `<dt>Deadline</dt><dd>${esc(e.deadline)}</dd>` : ""}
      ${e.next ? `<dt>Next</dt><dd><b>${esc(e.next.stage)}</b> — ${esc(e.next.does)}</dd>` : ""}
    </dl>
    ${e.releases.map((r) => `<p><b>Released ${esc(r.version)}</b> ${esc(r.at.slice(0, 10))} — locked. <code>sha256 ${esc(r.sha256)}</code><br>${/^https?:/.test(r.uri) ? `<a class="link" href="${esc(r.uri)}" target="_blank" rel="noopener">Listen</a> · ` : ""}${esc(r.invitation)}</p>`).join("")}
    <h3>In the showrunner's office</h3>
    ${e.repo ? `<p class="muted">Repo <code>${esc(e.repo.name)}@${esc(e.repo.head.slice(0, 7))}</code>${e.repo.remote ? ` · <a class="link" href="${esc(e.repo.remote.replace(/\.git$/, ""))}" target="_blank" rel="noopener">on GitHub</a>` : ""} — started from the show plan alone.</p>` : `<p class="muted">No repo yet. The showrunner opens it with the show plan when the first idea arrives.</p>`}
    ${e.lastTick ? `<p>Last rounds ${esc(e.lastTick.at.slice(0, 16).replace("T", " "))}: <b>${e.lastTick.load}</b> open candidates · gates on: ${e.lastTick.activeGates.map((g) => `<span class="tag">${esc(g)}</span>`).join(" ")}</p>` : ""}
    ${e.cuts.length ? `<ul class="scenes">${e.cuts.map((c) => `<li><code>${esc(c.ideaId)}</code><div><a class="link" data-cut="${esc(c.episodeId)}|${esc(c.ideaId)}"><b>${esc(c.title)}</b></a><br><span class="muted">${esc(c.approach)} · cast pinned at ${c.projections.map((p) => `${esc(p.character)}@${esc(p.sha.slice(0, 7))}`).join(", ")}</span></div><span class="tag">${esc(c.status)}</span></li>`).join("")}</ul>` : ""}
    ${e.lastTick?.held.length ? `<details><summary>${e.lastTick.held.length} held back, and why</summary><ul class="history">${e.lastTick.held.map((h) => `<li><a class="link" data-idea="${esc(h.ideaId)}">${esc(h.ideaId)}</a>: ${h.failed.map((f) => `<b>${esc(f.gate)}</b> — ${esc(f.why)}`).join("; ")}</li>`).join("")}</ul></details>` : ""}
    <h3>Release checklist</h3>
    <ul class="checklist">${e.checklist.map((c) => `<li class="${c.done ? "done" : ""}">${esc(c.task)}${c.detail ? ` <span class="muted">(${esc(c.detail)})</span>` : ""}</li>`).join("")}</ul>
    ${scenes.length ? `<h3>Scenes</h3><ul class="scenes">${scenes.map((s) => `<li class="${s.selected === false ? "cut" : ""}"><code>${esc(s.sceneId)}</code><div><span class="tt"><b>${esc(s.title)}</b> · ${esc(s.role)}</span><br><span class="muted">${esc(s.summary)}</span></div><span class="tag">${s.selected === null ? "open" : s.selected ? "kept" : "cut"}</span></li>`).join("")}</ul>` : ""}
  `);
}

async function showIdea(id) {
  const i = await api(`/api/ideas/${encodeURIComponent(id)}`);
  const s = i.signals;
  const creative = s.creative.length ? (s.creative.reduce((a, b) => a + b, 0) / s.creative.length).toFixed(1) : "–";
  open(`
    <p class="kicker">${esc(i.ideaId)} · ${esc(i.output)} · ${esc(i.status)}</p>
    <h2 id="drawer-title">${esc(i.title)}</h2>
    <dl class="dl">
      <dt>Question</dt><dd>${esc(i.question)}</dd>
      <dt>Source</dt><dd>${esc(i.source)}</dd>
      <dt>Proposed by</dt><dd>${esc(i.contributor.name)} · reuse: ${esc(i.contributor.reuse)} · ${esc(i.proposedAt.slice(0, 10))}</dd>
      ${i.episodeId ? `<dt>Episode</dt><dd><a class="link" data-ep="${esc(i.episodeId)}">${esc(i.episodeId)}</a></dd>` : ""}
      <dt>Signals</dt><dd>creative ${creative} · community ${s.community} · patron support ${s.financial ? usd(s.financial) : "–"}</dd>
    </dl>
    ${i.history.length ? `<h3>Decisions</h3><ol class="history">${i.history.map((h) => `<li>${esc(h.from)} → <b>${esc(h.to)}</b> (${esc(h.by)}, ${esc(h.at.slice(0, 10))}): ${esc(h.reason)}${h.result ? ` <i>Result: ${esc(h.result)}</i>` : ""}</li>`).join("")}</ol>` : ""}
    ${i.cuts?.length ? `<h3>First cuts</h3><ul class="history">${i.cuts.map((c) => `<li><a class="link" data-ep="${esc(c.episodeId)}">${esc(c.episodeId)}</a> — ${esc(c.approach)} · <code>${esc(c.repo)}@${esc(c.sha.slice(0, 7))}</code> · passed ${c.gatesPassed.length} gates · <a class="link" data-cut="${esc(c.episodeId)}|${esc(c.ideaId)}">read the cut</a></li>`).join("")}</ul>` : ""}
    ${i.notes.length ? `<h3>Notes</h3>${i.notes.map((n) => `<p class="muted">${esc(n.text)}</p>`).join("")}` : ""}
    ${i.runs.length ? `<h3>The room's work</h3><ol class="feed">${i.runs.map((r) => feedItem({ id: r.eventId, ts: r.at, type: "agent.run", actor: r.character, payload: { ...r, ideaId: undefined } })).join("")}</ol>` : ""}
    <div class="askbox">
      <button class="ghost" id="vote">Vote for this idea</button>
      <h3 style="margin-top:14px">Ask a character</h3>
      <p class="muted">${snap ? `${snap.limits.patronRunsToday} of ${snap.limits.patronDailyRuns} patron questions used today.` : ""}${snap?.offline ? " The characters are offline right now and answer from the record only." : ""}</p>
      <label>Your name<input id="ask-name" maxlength="60" placeholder="optional" /></label>
      <label>Question<textarea id="ask-q" rows="2" maxlength="500" placeholder="What has the room already tried along these lines?"></textarea></label>
      <div class="askers">
        ${Object.entries(snap?.roles || {}).map(([role, slug]) => `<button class="${esc(role)}" data-ask="${esc(slug)}">Ask ${esc(nameOf(slug))} ${esc(ROLE_VERBS[role]?.[1] || "")}</button>`).join("\n        ")}
      </div>
      <p class="form-msg" id="ask-msg" role="status"></p>
    </div>
  `);
  $("#vote").onclick = async (ev) => {
    try { await api(`/api/ideas/${encodeURIComponent(id)}/vote`, { method: "POST" }); ev.target.textContent = "Voted"; ev.target.disabled = true; }
    catch (err) { $("#ask-msg").textContent = err.message; $("#ask-msg").className = "form-msg err"; }
  };
  for (const b of document.querySelectorAll("[data-ask]"))
    b.onclick = async () => {
      const msg = $("#ask-msg");
      const question = $("#ask-q").value.trim() || `What should the room know about "${i.title}"?`;
      document.querySelectorAll("[data-ask]").forEach((x) => (x.disabled = true));
      msg.className = "form-msg"; msg.textContent = `${nameOf(b.dataset.ask)} is working…`;
      try {
        await api(`/api/ideas/${encodeURIComponent(id)}/ask`, { method: "POST", body: JSON.stringify({ character: b.dataset.ask, question, name: $("#ask-name").value }) });
        await showIdea(id);
      } catch (err) {
        msg.className = "form-msg err"; msg.textContent = err.message;
        document.querySelectorAll("[data-ask]").forEach((x) => (x.disabled = false));
      }
    };
}

async function showCut(episodeId, ideaId) {
  const c = await api(`/api/episodes/${encodeURIComponent(episodeId)}/cuts/${encodeURIComponent(ideaId)}`);
  open(`
    <p class="kicker">${esc(episodeId)} · first cut · <code>${esc(c.repo)}@${esc(c.sha.slice(0, 7))}</code></p>
    <h2 id="drawer-title"><a class="link" data-idea="${esc(ideaId)}">${esc(ideaId)}</a> — ${esc(c.approach)}</h2>
    <h3>Beats</h3><pre class="md">${esc(c.beats)}</pre>
    <h3>Script</h3><pre class="md">${esc(c.script)}</pre>
    <details><summary>Card: gates, estimates, cast pins</summary><pre class="md">${esc(c.card)}</pre></details>
  `);
}

document.addEventListener("click", (ev) => {
  const cut = ev.target.closest("[data-cut]");
  if (cut) { ev.preventDefault(); const [e, i] = cut.dataset.cut.split("|"); return showCut(e, i); }
  const ep = ev.target.closest("[data-ep]");
  const idea = ev.target.closest("[data-idea]");
  if (ep) (ev.preventDefault(), showEpisode(ep.dataset.ep));
  else if (idea) (ev.preventDefault(), showIdea(idea.dataset.idea));
});
drawer.addEventListener("click", (ev) => { if (ev.target === drawer) drawer.close(); });

// ------------------------------------------------------------ propose

$("#propose").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const msg = $("#propose-msg");
  const body = Object.fromEntries(f.entries());
  body.consent = f.get("consent") === "on";
  body.credit = f.get("credit") === "on";
  try {
    const r = await api("/api/ideas", { method: "POST", body: JSON.stringify(body) });
    msg.className = "form-msg";
    msg.innerHTML = `Received as <a class="link" data-idea="${esc(r.ideaId)}">${esc(r.ideaId)}</a>. It's on the board now.`;
    ev.target.reset();
  } catch (err) {
    msg.className = "form-msg err";
    msg.textContent = err.message;
  }
});

// ------------------------------------------------------------ boot

(async () => {
  await refresh();
  addToFeed(await api("/api/events"), false);
  connect();
})();
