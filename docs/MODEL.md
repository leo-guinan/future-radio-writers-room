# The writers' room model

A writers' room is a public workshop where a show is made in the open. Patrons watch and
contribute ideas, agents in three roles (memory, making, accounting) work on those ideas, and a showrunner (the fourth role, assembly) turns them into cuts.
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

## Layer 4. Roles and characters (agents)

**Separate the role from the character.** A role is a job the system needs done, a separation
of concerns that makes the room run. A character is the person who plays that role in a
particular show. The roles are the model. The characters are Future Radio's.

| Role | What the system needs from it | Future Radio's character |
|---|---|---|
| **Memory** | Retrieve what the record holds and cite it; never invent history | Borges, the librarian who has nothing but time |
| **Making** | Turn an idea into approaches, each with a stopping rule and a cost estimate | Leonardo, who can't stop imagining and is learning to finish |
| **Accounting** | Score story, business and participation (0–3 each); keep observed apart from projected; recommend `pursue`, `compare`, `defer` or `decline` | Agnolo, the bookkeeper who wants receipts |
| **Assembly** | Gate ideas and assemble first cuts into the episode repo | The showrunner (no persona) |

The order is part of the model: memory → making → accounting → assembly.

The characters fit Future Radio's story: a Renaissance inventor funding his work from the
future. You can use them, since everything here is CC0. But you'll have a better room if you
find characters of your own to put on top of the roles. A character you chose is one whose
shape you understand: you'll know how they'd answer, where they'd push back, and what
contributors are likely to notice about them. That's what makes the work, and the viewer
notes, feel true.

Each character's voice comes from three places: the show bible, their persona, and the canon
in their dressing room. The model is `claude-sonnet-5-5`. With no key the room falls back to
deterministic offline output, and every run is still recorded.

**Where it lives.**
- `characters/*.md`: personas and the show bible.
- `src/agents/characters.ts`: `systemFor`, `explore` and `ask`, the role pipeline.
- `src/agents/llm.ts`: `AnthropicLLM`, `OfflineLLM` and `makeLLM`.
- `cast.json`: who plays each role (`roles`), the show's name and host, who the principals
  are, and the promotion thresholds.
- `src/core/cast.ts`: `playedBy(role)`, `roleOf(character)`, and the role definitions.

**How to change it.**
- **Recast a role:** edit `roles` in `cast.json`, e.g. `"memory": "ada"`, and write the new
  character's persona in `characters/ada.md`. Their dressing room opens on first use. Runs
  record the role they were played in, so the showrunner, the ledger and the workshop page
  follow the casting, not the name. `test/roles.test.ts` recasts all three and checks that
  the work moves with them. The roles are validated: each needs its own character.
- **Add a character with no role:** add `characters/<slug>.md` and a dressing room, and list
  the slug in `cast.json`. Or start them as an extra and let the audience promote them.
- **Change what a role does:** change its function in `characters.ts`, keeping the outputs
  the showrunner reads (approaches, stopping rule, estimate, evaluation).
- **Models, per character.** The room calls models through OpenRouter (`OPENROUTER_API_KEY`),
  so each character can run on a different one; Anthropic directly (`ANTHROPIC_API_KEY`) is the
  fallback, and with neither the room runs offline. `cast.json` `models` maps a character slug,
  a role, `showrunner` or `default` to an OpenRouter id (`vendor/model`); `ROOM_MODEL` is the
  default's default. OpenRouter reports each call's cost, so compute is booked as observed USD.
  For another provider, implement the `LLM` interface (`complete({system, user, model}) →
  {text, usage, costUsd}`).
- **Blind tastings decide the casting.** `trial run <cards.json>` plays the same scene cards
  under several model line-ups (shuffled, labelled A, B, C) and opens a tasting. Until it is
  revealed, the runs (which name their models) stay producer-only and out of the dressing
  rooms. People pick the version they'd put on air and, per character, where that character
  sounds most like themselves. `trial reveal` publishes the line-ups with the tally and cost;
  `trial report` adds every revealed tasting up per character and model. Change `models` in
  `cast.json` on that evidence. Code: `src/scenes/trials.ts`; example: the three line-ups in
  `scenes/cards/e10-two-and-ten.json`.
- **Costs:** set `PRICE_INPUT_PER_MTOK` and `PRICE_OUTPUT_PER_MTOK`, and compute becomes
  observed USD on the accounting role's ledger. Unpriced tokens are booked as "unknown", never
  as free.
- **Scenes.** The characters can also play a scene together. A scene card has a setting, a
  situation, stakes, a stopping rule and a turn limit; each character in it gets a private
  motivation. The showrunner directs: it sees every motivation, picks who speaks next and gives
  them a beat. Each character answers from their own bible, the card, their own motivation and
  the transcript, never anyone else's motivation. Every line is a recorded run (committed to the
  speaker's dressing room, compute on the ledger). Motivations are producer-only events until
  the scene closes, then revealed unless the card says `"revealMotivations": false`. With an
  `episodeId`, the transcript lands in the episode repo as `scenes/S-xxxx.md`. A card file can
  hold a whole episode (`scenes: [...]`), played in order with each scene remembering the
  earlier ones, and guests: characters who exist only in the card (`guests` with a name and a
  persona; no dressing room). Code:
  `src/scenes/scenes.ts`; example card: `scenes/cards/two-songs.json`.
- **Abilities.** A cast member can be given things to do besides talk: `"abilities":
  ["design-voice"]`. With it, a character can describe a voice mid-scene and have three
  candidates made (ElevenLabs Voice Design). For a guest they can choose one on the spot, and
  that guest speaks with it in this scene and the scenes after it; for a principal they can only
  offer the three for review (`voice pick`). Once per character per scene. The cost arrives in
  the scene as a bill addressed to whoever plays accounting, and the next line is theirs; it's
  on the ledger, priced with `VOICE_DESIGN_PRICE_USD` or as previews of unknown cost. Things
  that happen between lines (`scene.happening`: a bill, a voice, a notice) are part of the
  transcript everyone sees. Code: `src/scenes/abilities.ts`.
- **Voice, just in time.** Scenes are text. When someone asks to hear a line, it is generated
  once in the speaker's production voice (`voice/voice.json` in their dressing room), cached by
  a hash of voice, model and text, recorded as `scene.voiced`, and booked on the ledger (priced
  with `TTS_PRICE_PER_1K_CHARS`, otherwise characters of unknown cost). Cached lines are served
  free; new generations by patrons are limited per day (`VOICE_PATRON_DAILY`) and per address
  (`VOICE_PER_IP`). Code: `src/scenes/voice.ts`. Change the provider by replacing `generate()`.

## Layer 5. Memory: dressing rooms, bibles and extras

**Decision.**
- Each principal has a **dressing room**: their own git repo of history (one commit per run,
  plus appearances in released episodes), notes, voice and canon.
- A **character bible** is generated from that repo by a separate tool, so anyone can load the
  character locally (`npx future-radio-character-bible chat .`).
- Viewers change characters by **pull request**: viewer notes and `CHARACTER.md` edits. History
  is written by the room only, and CI enforces this.
- Each bible can become a **voice agent** (`character-bible agent <dir> --publish`): the same
  persona and canon with a prompt written for talking aloud, in the character's production
  voice. Its settings and ElevenLabs id live in `voice/agent.json`, and the bible and the
  workshop page link to it. Nothing said on a call becomes canon.
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

### The morning episode

Every day a GitHub Action (`.github/workflows/daily.yml`) collects what people did since the
day before: their commits to the room's repo and to every attached creative asset repo
(`assets.json`; commits by characters and bots are left out), plus the ideas, votes, notes and
tasting feedback in the room itself, and the day's goals from `GOALS.md` (`## YYYY-MM-DD` plus
`## Standing`). The room plays a scene about it with its three roles and saves the transcript
in `episodes/daily/`. The phase of the season sets the characters' attitude, not the facts:
on the first mornings they can hardly believe they can see the people's work; by the end
(`DAILY_SEASON`, default 8) it's ordinary. In Future Radio's own story, Episode 10 happens
before the room has this sense at all.

Two modes. `local`: the room's log lives in the repo (`room/`), and the Action runs it and
commits. `remote`: the room runs on a server; the Action collects, asks the live room to record
through the producer console (`ROOM_URL` variable, `PRODUCER_TOKEN` secret), and commits the
transcript. Code: `src/daily/daily.ts`, `scripts/daily-action.mjs`.

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

### Spawning a room

`npm run room -- spawn "<idea>" --name <slug>` makes a new writers' room for a creative idea:
this engine (without Future Radio's history, episodes or tests), the idea as its show bible and
first season, the casting (`--cast memory=…`), every creative asset repo in `assets.json`
attached (`--assets none` or a list to choose), the daily Action in local mode, CC0, and a first
commit. `--publish --owner <you>` creates the GitHub repo with `gh`. Code: `src/spawn/spawn.ts`.

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
| GET | `/api/scenes` | Recent scenes (motivations only once closed) |
| GET | `/api/scenes/:id` | One scene with its transcript |
| GET | `/api/scenes/:id/lines/:n/audio` | One line as audio: cached, or generated now within the day's voice limits |
| GET | `/api/voices/designs` | Designed voices: who ordered them, for whom, what was chosen |
| GET | `/api/voices/designs/:id/:k.mp3` | One candidate voice |
| POST | `/api/producer/voices/designs/:id/pick` | Producer: `{k, character?, sceneId?, name?}` make a candidate a voice |
| GET | `/api/trials` | Blind tastings (line-ups only once revealed) |
| GET | `/api/trials/:id` | One tasting |
| POST | `/api/trials/:id/feedback` | `{favorite, mostThemselves: {character: label}, note?, name?}`; once per address, closed after reveal |
| GET | `/api/trials/report` | Revealed tastings per character and model |
| POST | `/api/producer/trials` | Producer: play a card file's line-ups and open a tasting (runs in the background) |
| POST | `/api/producer/trials/:id/reveal` | Producer: unblind |
| POST | `/api/producer/scenes` | Producer: open a scene `{title, setting, situation, stakes, stoppingRule, maxTurns?, episodeId?, ideaId?, revealMotivations?, cast: [{character, motivation}], run?}` and play it |

Producer only (`Authorization: Bearer $PRODUCER_TOKEN`): explore, move, signal, advance, tick,
`scorecard`, `scenes` and `console`.

## Contributing back

Use the route that matches what you have:

| You have… | Do this |
|---|---|
| An idea for an episode | `POST /api/ideas` on the live room, or open a proposal PR here |
| A note about a character | A viewer-note PR on that character's dressing room, or the extras repo |
| A capability you want but can't build | A proposal PR to this repo: `proposals/YYYY-MM-DD-short-name.md` (see `proposals/README.md`) |
| A capability you built | A PR with the code, linked to its proposal, with tests (`npm test`) |
