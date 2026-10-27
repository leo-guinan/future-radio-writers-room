# Future Radio — The Writers' Room

The room where Future Radio gets made, in public.

- **Borges remembers.** He retrieves earlier ideas, decisions, contradictions and abandoned branches from the archive — and cites every claim to a record. If it isn't in the record, it didn't happen yet.
- **Leonardo creates.** He turns an idea into at most three concrete approaches, each with a deliverable, a runtime, a cost estimate and a **stopping rule**.
- **Agnolo keeps the score.** He scores every candidate (story, business, participation, 0–3), sorts every claim into *observed / projected / disputed / unknown*, and keeps the three ledgers. The room does the budget arithmetic; Agnolo can't talk his way past it.

Patrons get a seat in the workshop: they watch the feed live, bring ideas, vote, and put questions to the characters.

## Run it

```bash
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

## Characters

Voices live in `characters/*.md` — edit them without touching code. `show-bible.md` is shared by all three.

## Deploy

```bash
cp .env.example .env    # set PRODUCER_TOKEN, ANTHROPIC_API_KEY, prices
docker compose up -d --build
```

The container seeds itself on first boot only and keeps the log on the `room-data` volume. Put any TLS proxy in front (e.g. Caddy: `room.example.com { reverse_proxy localhost:8787 }`). Run the producer console inside the container: `docker compose exec room npx tsx src/cli.ts status E10`.

Back up `/data/events.jsonl`. It's the whole show.

## Layout

```
characters/           personas (Markdown)
seed/season-1.json    the plan, as data
src/core/             event log, rules, state
src/agents/           Borges, Leonardo, Agnolo + model client
src/production/       the daily loop and checklist
src/server.ts         workshop API + live stream
src/cli.ts            producer console
public/               the workshop page (no build step)
test/                 rule tests
```
