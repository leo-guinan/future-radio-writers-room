# The writers' room model

A writers' room is a public workshop where a show is made in the open. Patrons watch and
contribute ideas, character agents work on those ideas, and a showrunner turns them into cuts.
Every decision is written down. This document describes the model layer by layer: what
Future Radio decided at each layer, where that decision lives, and how to change it.

Agents can learn this model with the [writers-room skill](https://github.com/leo-guinan/writers-room-skill).

The reference instance is live at **https://writers.story.markets**. Its code and record are public:

| Repo | Layer it holds |
|---|---|
| [future-radio-writers-room](https://github.com/leo-guinan/future-radio-writers-room) | The room: event log, rules, agents, showrunner, server, deploy |
| [future-radio-character-bible](https://github.com/leo-guinan/future-radio-character-bible) | The character-bible tool: build, check, chat, propose |
| [future-radio-dressing-room-borges](https://github.com/leo-guinan/future-radio-dressing-room-borges) · [-leonardo](https://github.com/leo-guinan/future-radio-dressing-room-leonardo) · [-agnolo](https://github.com/leo-guinan/future-radio-dressing-room-agnolo) | One repo per principal character: their history and bible |
| [future-radio-extras](https://github.com/leo-guinan/future-radio-extras) | Characters without a story of their own yet, one folder each |
| [future-radio-episode-e01](https://github.com/leo-guinan/future-radio-episode-e01) · [-e10](https://github.com/leo-guinan/future-radio-episode-e10) | One repo per episode: plan, cast projections, cuts, script, release, ledger |

```
patron idea ──▶ event log ──▶ showrunner round ──▶ gates ──▶ first cut in the episode repo
                  ▲   │            │                              │
                  │   │            └─ Borges remembers, Leonardo creates, Agnolo scores
                  │   └──▶ dressing rooms (each agent run is committed to its character's repo)
                  └── producer: select, write, generate, review, publish (locked), account
```

---

## Layer 1. The record

**Decision.** Everything that happens is an event in a single append-only, hash-chained JSONL log
(`data/events.jsonl`). State is a replay of the log, nothing is edited, and the public copy is
`seed/room-log.jsonl`.

**Where it lives.** `src/core/events.ts` (EventStore: append, sync, verify) and `src/core/room.ts`
(the replay).

**How to change it.**
- Store: keep the `EventStore` interface (`append`, `all`, `subscribe`, `sync`, `verify`, `head`)
  and back it with Postgres, SQLite or S3. The room doesn't care where the log lives.
- Visibility: each event has `visibility: public | producer`. Change the defaults where events
  are created in `room.ts`.
- New event types: add one to `types.ts` and handle it in `Room.apply()`. Old logs must still
  replay, so add types rather than changing them.

## Layer 2. The rules

**Decision.** Six rules are locked at seed time and enforced in code, not by convention:

1. Forecasts aren't receipts.
2. Founder hours aren't free.
3. Old investment isn't automatically a current expense (it goes in a separate historical ledger).
4. A released cut is immutable (sha256 recorded; a new version, never an edit).
5. Exceeding a cash ceiling requires an explicit, recorded decision.
6. Creative, community and financial signals stay separate; money doesn't buy editorial control.

Every rule raises a `RuleError(code, message)` that the API and CLI return as-is, so a
contributor always learns *which* rule stopped them. The codes are `receipts`, `immutable`,
`budget`, `signal`, `selection`, `lifecycle`, `consent`, `participation` and `production`.

**Where it lives.** `src/core/room.ts`. The rule text is in `seed/season-1.json` and
`characters/show-bible.md`.

**How to change it.** Change the text in the season seed and the show bible, then change the
matching `throw new RuleError(...)` sites. A room with different rules is a fork, not a
configuration. Say so in your README, because the rules are the show's promise to patrons.

## Layer 3. The work model

**Decision.**
- **Ideas** move forward only: `proposed → explored → compared → selected → produced →
  measured`, or sideways to `deferred`, `merged` or `declined`.
  - Every move records a reason.
  - Producing records what was made and learned; measuring records actual cash and hours.
  - Each idea needs a title, a creative question, a real source, a contributor, and a reuse
    choice (`cc-by`, `show-only` or `ask-first`).
- **Episodes** move one stage at a time: `planned → select → write → generate → review →
  publish → account`.
  - Each episode has a cash ceiling and a runtime range.
  - A release needs a sha256 and an invitation.
  - The checklist is derived from the record and never ticked by hand.

**Where it lives.**
- `src/core/types.ts`: `IDEA_STATUSES`, `EPISODE_STAGES`, `OutputKind`.
- `src/core/room.ts`: the transitions.
- `src/production/loop.ts`: the checklist and the "next step" text.
- `seed/season-1.json`: episodes, scenes, ideas and forecasts.

**How to change it.**
- **A different season:** replace `seed/season-1.json`. Give each episode a budget and a
  deadline, and give each scene its minutes and whether it is core.
- **Different stages:** edit `EPISODE_STAGES` and `STAGES` in `loop.ts`, plus the checklist items
  that depend on them.
- **New output kinds:** extend `OutputKind`. `capability` already exists, for ideas that are
  tools rather than scenes.

## Layer 4. The characters (agents)

**Decision.** Three principal agents, each with one job:
- **Borges remembers.** He retrieves from the log and his dressing room, never inventing history.
- **Leonardo creates.** He proposes approaches, each with a stopping rule and a cost estimate.
- **Agnolo keeps the score.** He scores story, business and participation (0–3 each), separates
  observed from projected, and recommends `pursue`, `compare`, `defer` or `decline`.

The voice comes from the show bible, the character's persona and the canon in their dressing
room. The model is `claude-sonnet-5-5`. With no key the room falls back to deterministic
offline output, and every run is still recorded.

**Where it lives.**
- `characters/*.md`: personas and the show bible.
- `src/agents/characters.ts`: `systemFor`, `explore` and `ask`.
- `src/agents/llm.ts`: `AnthropicLLM`, `OfflineLLM` and `makeLLM`.
- `cast.json`: who the principals are, and the promotion thresholds.

**How to change it.**
- **Another model:** set `ROOM_MODEL` and `CHARACTER_MODEL`. For another provider, implement the
  `LLM` interface (`complete(system, user) → {text, usage}`).
- **Other characters or jobs:** add `characters/<slug>.md` and a dressing room, then add the slug
  to `cast.json`.
- **A different job for an agent:** change the job inside `explore()`. The pipeline order
  (remember → create → evaluate) is the model; the names are Future Radio's.
- **Costs:** set `PRICE_INPUT_PER_MTOK` and `PRICE_OUTPUT_PER_MTOK`, and compute becomes observed
  USD on Agnolo's ledger. Unpriced tokens are booked as "unknown", never as free.

## Layer 5. Memory: dressing rooms, bibles and extras

**Decision.**
- Each principal has a **dressing room**: their own git repo of history (one commit per run,
  plus appearances in released episodes), notes, voice and canon.
- A **character bible** is generated from that repo by a separate tool, so anyone can load the
  character locally (`npx future-radio-character-bible chat .`).
- Viewers change characters by **pull request**: viewer notes and `CHARACTER.md` edits. History
  is written by the room only, and CI enforces this.
- Characters without a story yet live as folders in a shared **extras** repo. They are promoted
  to a dressing room, with their git history, when the thresholds in `cast.json` are met
  (2 appearances, 3 viewer notes, 5 votes).

**Where it lives.**
- `src/repos/dressing-room.ts`, `extras.ts`, `sync.ts` and `publish.ts`.
- The character-bible repo (`src/bible.js`, `src/github.js`).

**How to change it.**
- **Repo naming:** `REPO_PREFIX` and `GITHUB_OWNER`.
- **What a bible contains:** `bible.js` in the character-bible repo. It is separate from the room,
  so it can be versioned and reused by other shows.
- **What a PR may touch:** the `check` rules in the character-bible tool.
- **Promotion thresholds:** `cast.json`.
- **No GitHub at all:** dressing rooms are plain git repos. `sync` only pushes repos that have a
  remote.

## Layer 6. Assembly: the showrunner and its gates

**Decision.**
- **Each episode gets its own repo.** It starts empty apart from `SHOW_PLAN.md`. The showrunner
  projects each needed character from their dressing room into `cast/`, pinned to a commit and
  recorded in `PROVENANCE.json`.
- **Rounds run automatically.** A round runs on new ideas, and on a timer.
- **Cuts land in the episode repo.** Ideas that pass the active gates get a first cut in
  `cuts/<idea>/` (`CARD.md`, `BEATS.md`, `SCRIPT.md`).
- **Gates switch on as load grows.** Only five basic gates run at first. Stricter ones activate
  as open candidates pile up, at 6, 10, 15 and 25.

**Where it lives.**
- `src/showrunner/showrunner.ts` (the `tick`).
- `src/showrunner/gates.ts`: the `CHECKS` map.
- `gates.json`: thresholds and capacity.
- `src/repos/episode-repo.ts`.

**How to change it.**
- **Tune a gate:** change its `activateAt` or thresholds in `gates.json`. Each episode repo gets
  a copy, which tunes that one episode.
- **Add a gate:** add a function to `CHECKS` and an entry to `gates.json`.
- **Capacity:** `capacity.maxCutsPerTick`, `maxCutsPerEpisode` and `maxExploresPerTick`.
- **Cadence:** `SHOWRUNNER_AUTO`, `SHOWRUNNER_EVERY_SECONDS` and `SHOWRUNNER_DAILY_EXPLORES`.
- **Where unassigned ideas go:** `INTAKE_EPISODE`.

## Layer 7. Production

**Decision.** The room records production; the tools that do it are replaceable. Future Radio
generates audio with ElevenLabs (designed and library voices, two takes per line), mixes with
ffmpeg, and transcribes the final mix against the script before release. The cost is booked in
the room with its evidence; `episode-e10/assets.json` lists every generation.

**Where it lives.** `episode asset`, `episode release` and `ledger add` in the CLI. The episode
repo's `RELEASE.md`, `LEDGER.md` and `assets.json` show the shape.

**How to change it.** Use any generator. The room only needs:
- assets recorded by URI;
- the release file's sha256, and its URI if it is hosted elsewhere
  (`episode release EP --sha256 … --uri …`);
- the real cost and hours.

## Layer 8. Participation

**Decision.**
- **Patrons** can propose ideas, vote, and ask a character about an idea, within daily limits.
  They see public events live (`/api/stream`); producer-only events stay private.
- **Every release ends with a specific invitation.**
- **Contributors keep credit**, and choose how the show may reuse their idea.

**Where it lives.**
- `src/server.ts`: routes and limits.
- `public/`: the workshop page.
- The `PATRON_*` and `IDEAS_PER_IP` settings.

**How to change it.** Change the limits through those settings. Add routes in `server.ts`; the
producer routes are behind `PRODUCER_TOKEN`, and `/api/producer/console` runs any CLI command
remotely.

## Layer 9. Deploy

**Decision.**
- **One small VPS** (2 vCPU, 2 GB is plenty).
- **Docker Compose** runs the room, with Caddy for automatic HTTPS.
- **First boot** restores the published log and clones every repo from `GITHUB_OWNER`.
- **Secrets stay on the server.** `deploy/hetzner/install.sh` does all of this.

**How to change it.**
- **Any Docker host:** use the top-level `docker-compose.yml` and your own proxy. Don't buffer
  `/api/stream`.
- **Secrets:** `GITHUB_TOKEN` lets the room push its own commits; `ANTHROPIC_API_KEY` gives the
  characters their voices.

---

## API (reference instance)

Public:

| Method | Path | What it does |
|---|---|---|
| GET | `/api/room` | The current snapshot |
| GET | `/api/cast` | The principal characters |
| GET | `/api/extras` | The extras |
| GET | `/api/events` | Public events |
| GET | `/api/stream` | Public events, live (server-sent events) |
| GET | `/api/episodes/:id` | One episode |
| GET | `/api/episodes/:id/cuts/:idea` | A first cut |
| GET | `/api/ideas/:id` | One idea |
| POST | `/api/ideas` | Propose an idea: `{consent: true, name, title, question, source, output, episodeId?, credit, reuse, contact?}`. `output` is one of `scene`, `song`, `episode`, `trailer`, `capability`, `broadcast`, `other`; `reuse` is one of `cc-by`, `show-only`, `ask-first` |
| POST | `/api/ideas/:id/vote` | Vote for an idea |
| POST | `/api/ideas/:id/ask` | Ask a character about an idea: `{character: "borges"\|"leonardo"\|"agnolo", question, name?}` |

Producer only (`Authorization: Bearer $PRODUCER_TOKEN`): explore, move, signal, advance, tick,
`scorecard` and `console`.

## Contributing back

Use the route that matches what you have:

| You have… | Do this |
|---|---|
| An idea for an episode | `POST /api/ideas` on the live room, or open a proposal PR here |
| A note about a character | A viewer-note PR on that character's dressing room, or the extras repo |
| A capability you want but can't build | A proposal PR to this repo: `proposals/YYYY-MM-DD-short-name.md` (see `proposals/README.md`) |
| A capability you built | A PR with the code, linked to its proposal, with tests (`npm test`) |
