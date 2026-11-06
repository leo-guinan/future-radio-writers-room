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
npm run room -- humain demo --idea "Two frames: E01 vs E10, hook quote Midnight versus noon."
npm run room -- humain replay H-0001
npm run room -- humain frames
```

Tests: `npm test` (humain suites: `test/humain-session.test.ts`,
`test/humain-frame.test.ts`, `test/humain-reconcile.test.ts`).
Typecheck: `npm run typecheck`.

## The loop

The human has a time budget; the machine has a resource budget; the objective
is verified state reconciliation.

1. Pick a human input window: 2, 5, 15 or 60 minutes.
2. Press record (explicit start; microphone via `getUserMedia`).
3. Live transcript appears (on-device speech recognition; typed fallback
   included; server-side `muse-voice-transcribe-1.0` when `MODEL_API_KEY` is set).
4. Close input (or the deadline closes it): capture stops, the transcription
   connection closes, no more input is requested — and recording never restarts.
5. Make plan: the system inspects actual state and produces an explicit change
   contract — desired state, observed state, requirements already satisfied,
   reusable capabilities, required modifications, missing capabilities,
   acceptance tests, estimated costs, and (at approval) spending limits.
6. Approve the contract with an API spend ceiling (USD) and compute deadline.
7. Execute until acceptance tests pass, spending authority is exhausted,
   necessary approval is missing, a safety boundary is reached, or no further
   progress is viable. After each action the loop re-inspects actual state and
   recomputes the remaining delta; failed tests trigger bounded repair (2
   attempts); a progress-based watchdog halts runaway runs; halts preserve a
   checkpoint with all remaining requirements. No human attention is requested
   mid-run — pending decisions block their tasks.
8. Results, costs, tests, decisions, frames and artifacts append to
   `data/events.jsonl`, replayable in the UI or terminal.

Frames are persistent and shareable: `GET /api/humain/frames` lists them,
`GET /api/humain/frames/F-0001` serves one (each view increments its
independent visit count, including verification views).

## What was reused vs built

Reused from the room (verified at runtime by `src/humain/capabilities.ts`):
event store + hash chain, character memory/making/accounting architecture,
production loop + evidence pattern, three cost ledgers, forecasts, catalog of
works, showrunner gates. Estimates are booked as forecasts + projected ledger
entries; actuals as observed entries with evidence.

Built new in `src/humain/`: monotonic clock (`clock.ts`), trusted session
controller (`session.ts`), provider adapters (`adapters.ts`), capability
inventory (`capabilities.ts`), estimator (`estimate.ts`), restricted workspace
(`executor.ts`), Frame Maker (`frame-maker.ts`), persistent frame registry
(`frames.ts`), observed-state checks (`observe.ts`), change contracts
(`contract.ts`), progress watchdog (`watchdog.ts`), reconcile loop
(`reconcile.ts`), HTTP routes (`routes.ts`).
UI: `public/humain.html` + `public/humain.js`. CLI: `humain demo|replay|frames`.

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

Documented Meta Model API (`https://api.meta.ai/v1`), Bearer `MODEL_API_KEY`,
server-side only — keys never reach the browser or the disposable workspace:

- Transcription: `muse-voice-transcribe-1.0` file endpoint
  (`POST /asr/transcribe`, multipart) plus a realtime WebSocket client
  (`wss://…/asr/realtime`, credential in the JSON handshake). Without a key,
  on-device/typed input at $0. Server audio ingest: `POST
  /api/humain/sessions/:id/audio` (base64 WAV, transcribed and dropped, never
  stored) or `humain demo --voice-file f.wav` (mono 16-bit PCM WAV).
- Planning: `muse-spark-1.3` via `POST /chat/completions` (OpenAI-compatible).
  Without a Meta key, `meta/muse-spark-1.3` via OpenRouter when
  `OPENROUTER_API_KEY` is set (same weights, alternate route, labeled
  honestly); otherwise the deterministic rule-based planner at $0.
- Image generation: second-stage stub (`MetaImageGen`); activates when
  `META_IMAGE_URL` is set. Not wired into the demo.

Observed pricing: OpenRouter `meta/muse-spark-1.3` at $1.25/MTok in,
$4.25/MTok out (OpenRouter's listing, 2026-11-02); Meta direct pricing is not
published in the sources checked, so Meta-direct usage without a reported cost
is booked as unknown tokens, never as free. Voice is documented at $0.18/hr.

## Missing / not yet real

- Meta-direct and voice calls need `MODEL_API_KEY`; realtime voice has never
  run against the live socket.
- Frame ids allocate atomically at contract time (lock + reservation markers).
- Visit counts live in sidecar JSON (operational data); totals snapshot into
  frame/checkpoint events. Automated verification peeks without counting.
- No multi-session UI list; memory-only transcripts are lost on restart.
- Frame Maker builds one page shape (comparison + hook + counter); unknown
  plan capabilities execute as `unverified`, never silently.
- No mining, cryptocurrency, or desktop distribution, per the brief.
