# Future Radio — The Writers' Room

The room where Future Radio gets made, in public.

- **Borges remembers.** He retrieves earlier ideas, decisions, contradictions and abandoned branches from the archive — and cites every claim to a record. If it isn't in the record, it didn't happen yet.
- **Leonardo creates.** He turns an idea into at most three concrete approaches, each with a deliverable, a runtime, a cost estimate and a **stopping rule**.
- **Agnolo keeps the score.** He scores every candidate (story, business, participation, 0–3), sorts every claim into *observed / projected / disputed / unknown*, and keeps the three ledgers. The room does the budget arithmetic; Agnolo can't talk his way past it.

Patrons get a seat in the workshop: they watch the feed live, bring ideas, vote, and put questions to the characters.

## Run it

```bash
# with ../future-radio-character-bible checked out next to this repo
npm install
cp .env.example .env        # optional: ANTHROPIC_API_KEY for the characters' own voices
npm run seed                # Episode 10, the season, the original forecasts
npm start                   # http://localhost:8787
npm run room -- help        # producer console
npm test
```

Without an API key the characters run **offline**: Borges answers straight from the record, Leonardo and Agnolo use rule-based sketches and scoring, and every run is logged at $0. With a key, set `PRICE_INPUT_PER_MTOK` / `PRICE_OUTPUT_PER_MTOK` so compute lands on the ledger as observed dollars; otherwise it's recorded as *unknown* tokens — never as free.

## Everything is an event

`data/events.jsonl` is the archive: append-only, one event per line, each hash-chained to the one before. Nothing is rewritten; corrections are new events. `npm run verify` re-walks the chain. The server, the CLI and the characters all read and write the same log, and the workshop page is just a replay of it.

## The locked rules (enforced in `src/core/room.ts`)

1. **Forecasts aren't receipts.** Projected money is shown, never counted. Financial support needs a receipt.
2. **Founder hours aren't free.** Hours go in the effort ledger, every episode.
3. **Old investment isn't a November expense.** Historical spend has its own ledger.
4. **A released cut is immutable.** After release, an episode's scenes and assets are frozen and the released file's sha256 is on the record. A new version gets a new number.
5. **Ceilings hold.** Observed cash past an episode's ceiling is refused until `budget EP N --reason` is recorded.
6. **Three signals, never summed.** Creative judgment, community votes and patron money sit side by side. A wealthy patron doesn't become the editor.

## Producing an episode

Every episode runs the same loop. `status EP` derives the release checklist from the record.

```bash
npm run room -- status E10
npm run room -- episode advance E10 write --note "Six sequences, frame locked"
npm run room -- episode asset E10 script "Six-sequence script" scripts/e10.md
npm run room -- episode advance E10 generate
npm run room -- episode asset E10 audio "Mix v1" audio/e10-v1.mp3
npm run room -- episode advance E10 review
npm run room -- episode advance E10 publish --note "One listen-through, two defects fixed"
npm run room -- episode release E10 audio/e10-v1.mp3 --uri https://… \
     --invitation "Describe a song that doesn't exist yet."
npm run room -- episode account E10 --cash 12.40 --evidence inv_123 --hours 7 \
     --learned "Cut the roll call earlier."
```

Ideas move `proposed → explored → compared → selected → produced → measured`, or exit as `deferred / merged / declined` with a reason that stays in the archive:

```bash
npm run room -- explore I-0008        # Borges → Leonardo → Agnolo, then marks it explored
npm run room -- idea move I-0008 selected --reason "Wins round 1 on story and votes"
npm run room -- signal I-0008 financial 25 --receipt pi_123
npm run room -- board
npm run room -- scorecard
npm run room -- forecast resolve F-002 supported --observation "E02 cost $14.10"
npm run room -- conference weekly "Round 1" --exhibits ev_000065,ev_000071 --notes "…"
```

## What patrons can and can't see

Public: the feed, the season, scenes and selection reasons, ideas and their decisions, character runs on ideas, Agnolo's scorecard totals, public forecasts.
Producer-only: ledger line items, financial signals, contributor contact details, and anything recorded `--private`. The seeded client-value forecast is producer-only; flip it by re-recording if you want it on the screen.

Limits (all in `.env`): `PATRON_DAILY_RUNS` character questions per day across the room, `PATRON_RUNS_PER_IP`, `IDEAS_PER_IP`. Each run is on the ledger, so patron curiosity has a visible cost.

## Dressing rooms, episode repos, and the showrunner

```
repos/
  dressing-room-borges/      CHARACTER.md · history/ · history.jsonl · memory/ · voice/
  dressing-room-leonardo/
  dressing-room-agnolo/
  dressing-room-showrunner/
  episode-e02/               SHOW_PLAN.md · gates.json · cast/ · cuts/ · GATES.md · PROVENANCE.json
```

**Dressing rooms.** Each character has their own repo. Their persona is `CHARACTER.md` there — the room reads it on every run, so editing a dressing room changes the character. Every run is a commit with a history file whose frontmatter carries the room event id and hash; the room log records the commit sha back. `remember borges "…"` adds a durable note.

**Episode repos** start with only `SHOW_PLAN.md` and `gates.json`. Everything else arrives by *projection*: `cast/<character>.md` is a copy of that character's persona, notes and most relevant history, pinned to a dressing-room commit, with `PROVENANCE.json` recording repo, commit, source files and sha256. Episodes never edit dressing rooms.

**The showrunner** makes rounds on an episode (`showrunner tick EP`, automatically when ideas arrive, and on a timer):

1. opens the episode repo from the show plan if it doesn't exist,
2. sends unexplored ideas to Borges → Leonardo → Agnolo (capped per round and per day),
3. switches gates on by load and checks every open candidate,
4. for the best ready ideas within capacity, projects the cast and assembles a first cut (`cuts/<idea>/CARD.md, BEATS.md, SCRIPT.md`), commits it, and marks the idea *compared*,
5. writes `GATES.md` — every idea held back, and the gate that held it.

A first cut is a draft for comparison. Selection stays with you.

**Gates tighten with load** (`gates.json`; each episode repo has its own editable copy):

| Open candidates | Gates on |
|---|---|
| any | consent (ask-first needs a "consent confirmed" note), explored, not-declined, stopping-rule, budget-fit |
| 6+ | agnolo-score ≥ 5/9 |
| 10+ | signal: a community vote or creative judgment ≥ 2 |
| 15+ | novelty: not a near-duplicate of an existing cut (merge instead) |
| 25+ | producer-approval |

Capacity: 2 cuts and 3 explorations per round, 6 cuts per episode; ready ideas over capacity are queued, not dropped.

**Publishing to GitHub** is explicit: `repos publish --owner YOU` prints the plan; add `--yes` to create the repos (private by default) with `gh` and push. Dressing rooms contain producer-only runs, so keep them private unless you've decided otherwise.

## Character bibles and viewer pull requests

Every dressing room carries a **character bible** in `bible/`, generated by
[`future-radio-character-bible`](../future-radio-character-bible) — a separate repo:

- `bible/BIBLE.md` — identity, canon, how they've sounded, their record, relationships, how they changed
- `bible/system-prompt.md` — the character, loadable into any model
- `bible/bible.json` — the same, structured, with a hash of every input

The bible is rebuilt with every run and note, so the committed bible always matches its
sources. Merged canon (your notes plus viewers' notes) rides along on every room run and
is projected into each episode's `cast/` files.

Talk to a character locally — offline, or with `ANTHROPIC_API_KEY` set:

```bash
npm run room -- bible chat borges          # /propose <note> drafts a viewer note
npm run room -- bible show borges          # the system prompt, to paste anywhere
npx future-radio-character-bible chat ./repos/dressing-room-borges   # same, straight from the repo
```

**Viewers change characters by pull request.** Each dressing room ships `CONTRIBUTING.md`,
a PR template, a "Viewer note" issue form, and a workflow that runs
`character-bible check` on every PR and rebuilds the bible on merge. The check enforces:
`history/` is the room's record and never edited; `memory/notes.md` is append-only;
viewer notes need `from:` and `experience:`; `bible/` is generated. `CHARACTER.md`
proposals are allowed and flagged for close review.

`repos sync` (and the server, every `SYNC_EVERY_SECONDS`) pulls merged PRs into the
dressing rooms, rebuilds bibles, and pushes the room's new history back. Conflicts in
`bible/` resolve themselves by rebuilding; anything else stops that room's sync and is
reported, never forced.

`repos publish --owner YOU --yes` creates the bible tool repo first (public, since the
dressing rooms' CI fetches it), points every dressing room's workflow at
`github:YOU/future-radio-character-bible`, then creates the rest (private by default).

## Characters

Templates live in `characters/*.md` and seed each dressing room the first time. After that, edit `CHARACTER.md` in the dressing room. `show-bible.md` is shared by all.

## Deploy

```bash
cp .env.example .env    # set PRODUCER_TOKEN, ANTHROPIC_API_KEY, prices, GITHUB_OWNER
docker compose up -d --build
```

The image builds from the parent directory so the sibling `future-radio-character-bible`
repo is in context (it's a `file:` dependency for now). Once that repo is on GitHub, change
the dependency to `github:YOU/future-radio-character-bible` and the context back to `.`.

The container seeds itself on first boot only and keeps the log on the `room-data` volume. Put any TLS proxy in front (e.g. Caddy: `room.example.com { reverse_proxy localhost:8787 }`). Run the producer console inside the container: `docker compose exec room npx tsx src/cli.ts status E10`.

Back up `/data/events.jsonl`. It's the whole show.

## Layout

```
characters/           personas (Markdown)
seed/season-1.json    the plan, as data
src/core/             event log, rules, state
src/agents/           Borges, Leonardo, Agnolo + model client
src/repos/            git wrapper, dressing rooms, episode repos, GitHub publish
src/showrunner/       the showrunner and its quality gates
gates.json            default gates and capacity
src/production/       the daily loop and checklist
src/server.ts         workshop API + live stream
src/cli.ts            producer console
public/               the workshop page (no build step)
test/                 rule tests
```
