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
  renderScenes();
  renderTastings();
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
    case "scene.opened": return [actor, `opened scene <a class="link" data-scene="${esc(p.sceneId)}">${esc(p.sceneId)}</a> <b>${esc(p.title)}</b> with ${p.cast.map((c) => esc(nameOf(c))).join(" and ")}. It ends when ${esc(lower(p.stoppingRule))}`];
    case "scene.closed": return [actor, `closed scene <a class="link" data-scene="${esc(p.sceneId)}">${esc(p.sceneId)}</a> after ${p.turns} lines: ${esc(p.reason)}${p.motivations ? ". What each of them wanted is now shown." : ""}`];
    case "scene.voiced": return [actor, `voiced line ${p.n} of <a class="link" data-scene="${esc(p.sceneId)}">${esc(p.sceneId)}</a> (${esc(nameOf(p.character))}, ${p.characters} characters)`];
    case "scene.happening": return [actor, `${p.kind === "bill" ? "<b>billed the room</b>" : p.kind === "voice" ? "made a voice" : "—"} in <a class="link" data-scene="${esc(p.sceneId)}">${esc(p.sceneId)}</a>: ${esc(p.text)}`];
    case "voice.designed": return [actor, `designed three candidate voices for ${esc(nameOf(p.forCharacter))} (${esc(p.designId)}): <i>${esc(p.description)}</i>`];
    case "voice.selected": return [actor, `gave ${esc(nameOf(p.character))} candidate ${p.k} of ${esc(p.designId)}${p.sceneId ? ` in ${esc(p.sceneId)}` : ""}`];
    case "trial.opened": return [actor, `opened a blind tasting <a class="link" data-trial="${esc(p.trialId)}">${esc(p.trialId)}</a> <b>${esc(p.title)}</b>: ${p.entries.length} versions, labelled ${p.entries.map((e) => esc(e.label)).join(", ")}`];
    case "trial.feedback": return [actor, `tasted <a class="link" data-trial="${esc(p.trialId)}">${esc(p.trialId)}</a> and liked ${esc(p.favorite)}${p.note ? `: <i>${esc(p.note)}</i>` : ""}`];
    case "trial.revealed": return [actor, `<b>revealed</b> <a class="link" data-trial="${esc(p.trialId)}">${esc(p.trialId)}</a> after ${p.responses} responses`];
    case "daily.recorded": return [actor, `recorded daily episode ${p.number} (${esc(p.day)}): looked over ${p.changes} things that came in and ${p.goals} goals — <a class="link" data-scene="${esc(p.sceneId)}">${esc(p.sceneId)}</a>`];
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
    const asked = p.askedBy.startsWith("scene:") ? "in a scene" : p.askedBy.startsWith("patron:") ? `asked by ${esc(p.askedBy.slice(7))}` : `for ${esc(p.askedBy)}`;
    const sceneOf = /^scene:(S-\d{4})$/.exec(p.askedBy || "");
    const target = sceneOf ? ` in <a class="link" data-scene="${esc(sceneOf[1])}">${esc(sceneOf[1])}</a>` : p.ideaId ? ` on <a class="link" data-idea="${esc(p.ideaId)}">${esc(p.ideaId)}</a>` : "";
    return `<li class="${esc(p.character)} ${esc(p.role || roleOf(p.character) || "")}"><time>${time}</time><div><div class="who">${esc(nameOf(p.character))} · ${asked}${target}${p.offline ? " · offline" : ""}</div>${runBody(p)}</div></li>`;
  }
  const [actor, what] = line(e);
  return `<li class="${who(e)}"><time>${time}</time><div><div class="who">${esc(actor)}</div><p class="what">${what}</p></div></li>`;
}

function addToFeed(events, prepend = true) {
  const feed = $("#feed");
  const fresh = events.filter((e) => e && !seen.has(e.id) && !(e.type === "repo.commit" && e.actor !== "showrunner") && !(e.type === "repo.commit" && /^First cut/.test(e.payload.message)) && e.type !== "scene.turn" && e.type !== "scene.motivation");
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
    if (e.type.startsWith("scene.") && openScene === e.payload.sceneId) showScene(openScene);
    refreshSoon();
  };
  es.onerror = () => $("#onair").classList.add("off");
}

// ------------------------------------------------------------ drawers

const drawer = $("#drawer");
const open = (html, { wide = false } = {}) => {
  $("#drawer-body").innerHTML = html;
  drawer.classList.toggle("wide", wide);
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

// ------------------------------------------------------------ scenes

const HAPPENING = { bill: "Bill", voice: "Voice", notice: "Meanwhile" };
/** Something that happened between lines; a voice design shows its three candidates. */
function happeningHtml(h) {
  const previews = h.kind === "voice" && h.ref ? `<div class="previews" data-design="${esc(h.ref)}">${[1, 2, 3].map((k) => `<span class="preview"><span class="muted small">${k}</span><audio controls preload="none" src="/api/voices/designs/${esc(h.ref)}/${k}.mp3"></audio></span>`).join("")}</div>` : "";
  return `<li class="happening ${esc(h.kind)}"><b>${HAPPENING[h.kind] || "Meanwhile"}.</b> ${esc(h.text)}${previews}</li>`;
}
const happeningsAfter = (s, n) => (s.happenings || []).filter((h) => h.afterTurn === n).map(happeningHtml).join("");

const lower = (s) => String(s || "").replace(/^./, (c) => c.toLowerCase());
let openScene = null;

async function renderScenes() {
  const list = await api("/api/scenes").catch(() => []);
  const el = $("#scenes");
  if (!list.length) {
    el.innerHTML = `<p class="muted empty">No scenes yet.</p>`;
    return;
  }
  el.innerHTML = list
    .slice(0, 6)
    .map(
      (s) => `<button class="scene-card ghost" data-scene="${esc(s.sceneId)}">
        <span class="scene-id">${esc(s.sceneId)} · ${s.closed ? `${s.turns.length} lines` : `playing · ${s.turns.length}/${s.maxTurns}`}</span>
        <b>${esc(s.title)}</b>
        <span class="muted">${s.cast.map((c) => esc(c.name)).join(" & ")}</span>
      </button>`,
    )
    .join("");
}

async function showScene(id) {
  const s = await api(`/api/scenes/${id}`);
  openScene = id;
  const nameIn = (c) => s.cast.find((x) => x.character === c)?.name || nameOf(c);
  const lines =
    happeningsAfter(s, 0) +
    s.turns
      .map(
        (t) => `${t.cue ? `<li class="cue">${esc(t.cue)}</li>` : ""}<li class="${esc(t.character)} ${esc(roleOf(t.character) || "")}">
        <div class="who">${esc(nameIn(t.character))}</div>
        <p>${esc(t.line)}</p>
        ${/^\(offline/.test(t.line) ? "" : `<button class="play ghost" data-play="${esc(s.sceneId)}/${t.n}" aria-label="Hear line ${t.n}">${t.voiced ? "▶" : "▷"} hear</button>`}
      </li>${happeningsAfter(s, t.n)}`,
      )
      .join("");
  const wanted = s.motivations
    ? `<h3>What each of them wanted</h3><ul class="wanted">${s.cast.map((c) => `<li><b>${esc(c.name)}:</b> ${esc(s.motivations[c.character])}</li>`).join("")}</ul>`
    : s.closed
      ? `<p class="muted">This scene keeps what they wanted to itself.</p>`
      : `<p class="muted">What each of them wants is shown when the scene ends.</p>`;
  open(`<h2>${esc(s.sceneId)} — ${esc(s.title)}</h2>
    <dl class="scene-card-dl">
      <dt>Setting</dt><dd>${esc(s.setting)}</dd>
      <dt>Situation</dt><dd>${esc(s.situation)}</dd>
      <dt>At stake</dt><dd>${esc(s.stakes)}</dd>
      <dt>Ends when</dt><dd>${esc(s.stoppingRule)}</dd>
    </dl>
    <ol class="script">${lines || `<li class="muted">The scene hasn't started.</li>`}</ol>
    <p class="muted">${s.closed ? `Closed: ${esc(s.closed.reason)}.${s.closed.repo ? ` Transcript in <code>${esc(s.closed.repo.name)}/${esc(s.closed.repo.file)}</code>.` : ""}` : `Playing · ${s.turns.length} of at most ${s.maxTurns} lines.`}</p>
    ${wanted}
    <p class="muted small">Lines are text until someone asks to hear them; then each is generated once in the character's voice and kept, so it is only paid for once. Improvised here; nothing is canon until it is in a released episode.</p>`);
}

const player = new Audio();
document.addEventListener("click", async (ev) => {
  const sc = ev.target.closest("[data-scene]");
  if (sc) return void showScene(sc.dataset.scene).catch((e) => alertIn(e.message));
  const play = ev.target.closest("[data-play]");
  if (!play) return;
  const [id, n] = play.dataset.play.split("/");
  play.disabled = true;
  play.textContent = "… voicing";
  try {
    const res = await fetch(`/api/scenes/${id}/lines/${n}/audio`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Couldn't voice that line (${res.status}).`);
    player.src = URL.createObjectURL(await res.blob());
    await player.play();
    play.textContent = "▶ hear";
  } catch (e) {
    play.textContent = "▷ hear";
    play.insertAdjacentHTML("afterend", `<span class="form-msg err">${esc(e.message)}</span>`);
  } finally {
    play.disabled = false;
  }
});
const alertIn = (m) => open(`<p class="form-msg err">${esc(m)}</p>`);

// ------------------------------------------------------------ blind tastings

async function renderTastings() {
  const list = await api("/api/trials").catch(() => []);
  const el = $("#tastings");
  if (!list.length) {
    el.innerHTML = `<p class="muted empty">No tastings yet.</p>`;
    return;
  }
  el.innerHTML = list
    .slice(0, 6)
    .map(
      (t) => `<button class="scene-card ghost" data-trial="${esc(t.trialId)}">
        <span class="scene-id">${esc(t.trialId)} · ${t.revealed ? "revealed" : "blind"} · ${t.entries.length} versions · ${t.responses} ${t.responses === 1 ? "response" : "responses"}</span>
        <b>${esc(t.title)}</b>
        <span class="muted">${esc(t.question)}</span>
      </button>`,
    )
    .join("");
}

async function showTrial(id) {
  const t = await api(`/api/trials/${id}`);
  const version = (e) => {
    const rev = t.revealed;
    const l = rev?.lineups[e.label];
    const r = rev?.tally[e.label];
    const head = rev
      ? `<div class="lineup">${l.name ? `<b>${esc(l.name)}</b><br>` : ""}${Object.entries(l.models).map(([k, m]) => `${esc(k)}: <code>${esc(m)}</code>`).join("<br>")}<div class="muted small">favourite of ${r.favorite} · ${r.lines} lines · ${r.costUsd === null ? "cost unknown" : usd(r.costUsd)}${Object.keys(r.mostThemselves).length ? ` · most themselves: ${Object.entries(r.mostThemselves).map(([c, n]) => `${esc(nameOf(c))} ×${n}`).join(", ")}` : ""}</div></div>`
      : "";
    const scenes = e.scenes
      .map((s) => `<h4>${esc(s.title)}</h4><ol class="script">${happeningsAfter(s, 0)}${s.turns.map((x) => `${x.cue ? `<li class="cue">${esc(x.cue)}</li>` : ""}<li class="${esc(x.character)} ${esc(roleOf(x.character) || "")}"><div class="who">${esc(x.name)}</div><p>${esc(x.line)}</p></li>${happeningsAfter(s, x.n)}`).join("") || `<li class="muted">Still playing…</li>`}</ol>`)
      .join("");
    return `<section class="version"><h3>Version ${esc(e.label)}</h3>${head}${scenes}</section>`;
  };
  const labels = t.entries.map((e) => e.label);
  const pick = (name, extra = "") => labels.map((l) => `<label class="pick"><input type="radio" name="${esc(name)}" value="${esc(l)}" ${extra}/> ${esc(l)}</label>`).join("");
  const form = t.revealed
    ? `<p class="muted">Revealed. ${t.responses} ${t.responses === 1 ? "person" : "people"} tasted it blind.</p>`
    : `<form id="taste" data-trial="${esc(t.trialId)}" class="taste">
        <fieldset><legend>Which version would you put on air?</legend>${pick("favorite", "required")}</fieldset>
        ${t.characters.map((c) => `<fieldset><legend>Where does ${esc(c.name)} sound most like ${esc(c.name.replace(/ \(.*\)$/, ""))}?</legend>${pick(`mt:${c.character}`)}</fieldset>`).join("")}
        <label>Why? (optional)<textarea name="note" rows="2" maxlength="1000"></textarea></label>
        <label>Your name (optional)<input name="name" maxlength="60" placeholder="a listener" /></label>
        <button type="submit">Send</button>
        <p class="form-msg" id="taste-msg"></p>
      </form>`;
  open(`<h2>${esc(t.trialId)} — ${esc(t.title)}</h2>
    <p>${esc(t.question)}</p>
    <div class="versions">${t.entries.map(version).join("")}</div>
    ${form}
    ${t.feedback.length ? `<h3>What people said</h3><ul class="wanted">${t.feedback.map((f) => `<li><b>${esc(f.name)}</b> liked ${esc(f.favorite)}${f.note ? `: ${esc(f.note)}` : ""}</li>`).join("")}</ul>` : ""}`, { wide: true });
}

document.addEventListener("click", (ev) => {
  const tr = ev.target.closest("[data-trial]");
  if (tr && tr.tagName !== "FORM") showTrial(tr.dataset.trial).catch((e) => alertIn(e.message));
});
document.addEventListener("submit", async (ev) => {
  if (ev.target.id !== "taste") return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  const mostThemselves = {};
  for (const [k, v] of f.entries()) if (k.startsWith("mt:")) mostThemselves[k.slice(3)] = v;
  const msg = $("#taste-msg");
  try {
    await api(`/api/trials/${ev.target.dataset.trial}/feedback`, { method: "POST", body: JSON.stringify({ favorite: f.get("favorite"), mostThemselves, note: f.get("note"), name: f.get("name") }) });
    msg.className = "form-msg";
    msg.textContent = "Thank you. It stays blind until the tasting is revealed.";
    ev.target.querySelector("button").disabled = true;
  } catch (e) {
    msg.className = "form-msg err";
    msg.textContent = e.message;
  }
});

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
