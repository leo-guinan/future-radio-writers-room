# HumAIn OS prototype (inside the Future Radio writers' room)

A voice-first, human-time-bounded agent session: speak an idea, get a costed,
executable plan, approve it with a hard spend ceiling and compute deadline, and
watch it execute in a restricted workspace. Everything lands in the room's
existing event log.

## Run it

```bash
npm install
npm start                 # http://localhost:8787/humain — open this in a browser
```

No API keys needed: offline adapters keep the whole loop working at $0.
For the room's characters, `cp .env.example .env` is still optional.

Terminal-only path (simulated speech, same controllers):

```bash
npm run room -- humain demo --idea "Build a webpage comparing The First Transmission and E10 with one hook and a vintage visitor counter."
npm run room -- humain replay H-0001
```

Tests: `npm test` (humain suites: `test/humain-session.test.ts`,
`test/humain-frame.test.ts`). Typecheck: `npm run typecheck`.

## The loop

1. Pick a human input window: 2, 5, 15 or 60 minutes.
2. Press record (explicit start; microphone via `getUserMedia`).
3. Live transcript appears (on-device speech recognition; typed fallback
   included for browsers without it).
4. Close input (or the deadline closes it): capture stops, the transcription
   connection closes, no more input is requested — and recording never restarts.
5. Make plan: structured tasks, capability reuse/build table, labeled ESTIMATE.
6. Approve with an API spend ceiling (USD) and compute deadline (seconds).
7. Execute in a restricted workspace; results, costs, tests, decisions and
   artifacts append to `data/events.jsonl`, replayable in the UI or terminal.

## What was reused vs built

Reused from the room (verified at runtime by `src/humain/capabilities.ts`):
event store + hash chain, character memory/making/accounting architecture,
production loop + evidence pattern, three cost ledgers, forecasts, catalog of
works, showrunner gates. Estimates are booked as forecasts + projected ledger
entries; actuals as observed entries with evidence.

Built new in `src/humain/`: monotonic clock (`clock.ts`), trusted session
controller (`session.ts`), provider adapters (`adapters.ts`), capability
inventory (`capabilities.ts`), estimator (`estimate.ts`), restricted workspace
(`executor.ts`), Frame Maker (`frame-maker.ts`), HTTP routes (`routes.ts`).
UI: `public/humain.html` + `public/humain.js`. CLI: `humain demo|replay`.

## Safety properties (enforced in code, not prompts)

- Deadlines use a monotonic clock (`process.hrtime`); wall time is display only.
- Budgets and deadlines are checked before every task; late actions are rejected.
- No unrestricted shell, no network, no env/credentials, no deploy or publish
  inside the disposable workspace (allowlist: read/write/list files under it).
- Pending decisions become blocked tasks; success without evidence is recorded
  as unverified, never success.
- Manual stop and revocation work from any state, at any time.
- Raw audio is ephemeral: chunks are discarded in the browser, never uploaded
  or stored. Transcripts reach the log only with explicit opt-in.

## Meta integrations (adapters)

- Transcription: `muse-voice-transcribe-1.0` when `META_VOICE_API_KEY` +
  `META_VOICE_URL` are set; otherwise on-device/typed input at $0.
- Planning: `muse-spark-1.3` when `META_SPARK_API_KEY` + `META_SPARK_URL` are
  set; otherwise a deterministic rule-based planner at $0.
- Image generation: second-stage stub (`MetaImageGen`); activates when
  `META_IMAGE_URL` is set. Not wired into the demo.

## Missing / not yet real

- Live Meta endpoints are configured, not provisioned: no keys or URLs exist
  yet, so the Meta adapters have never run against real services.
- No multi-session UI list, no session resume across server restarts beyond
  log rebuild (memory-only transcripts are lost on restart, by design).
- Frame Maker builds one page shape (comparison + hook + counter); unknown
  plan capabilities execute as `unverified`, never silently.
- No mining or cryptocurrency payments, per the brief.
