# Future Radio, the station

A 24-hour, autonomous Future Radio. The episodes play on a clock-synced schedule inside a static
frame. The cast watch the Community Archive and break in with bulletins when something they've
been told to listen for comes through. Everything it produces is open to pull, fork, layer and
connect.

```
                    ┌──────────────────────── the frame (/station) ─────────────────────────┐
  YouTube ────────► │  inner: the scheduled episode     │  UP NEXT · ARCHIVE WIRE · RULES    │ ──► any browser
  (program track)   │  bulletins: card + cast's voices  │                                    │ ──► OBS (layer it)
                    └────────────────────────────────────────────────────────────────────────┘
  Community Archive ─► watcher ─► safety ─► bulletin ─► voices ─► log ─► /station/feed/live (SSE)
  "Leonardo, watch tenso…" ─► transcript ─► change contract ─► approve ─► rules
  compositor (Chrome + ffmpeg) ─► routes: YouTube · Twitch · any RTMP · a file
```

## Run it

```bash
cp .env.example .env              # set PRODUCER_TOKEN, ELEVENLABS_API_KEY, STATION_ARCHIVE_MCP_URL
docker compose up -d              # the room + station on :8787, watcher on
open http://localhost:8787/station
docker compose --profile broadcast up -d   # also push to YouTube/Twitch (stream keys in .env)
```

Without Docker: `npm start`, then open `/station`.

## Two tracks

| Track | Comes from | How to address it |
|---|---|---|
| **Program** | The scheduled episode. Plays from YouTube when `station/programs.json` has its video id, and otherwise from the station's own file. | `?layers=program`, or `/station/feed/now.json` (episode and offset) |
| **Station** | The frame, the archive wire and the cast's bulletins, with their own audio. | `?layers=frame,bulletins,wire&bg=transparent`, or `/station/feed/live` |

For web viewers, the program streams from YouTube, so the station serves only a page and some
JSON. That's the frame within a frame: the outer frame stays put while the inner one plays.

### Routing

| Path | Gets the program from | Needs |
|---|---|---|
| Web frame (`/station`) | YouTube embed | nothing: always on |
| OBS / any compositor | Load `/station?...&bg=transparent` as a browser source, then layer it over anything | nothing |
| YouTube / Twitch / RTMP | The compositor plays the station's own files (`?inner=local`), captures picture and sound, and sends one encode to every route | stream keys in `.env` |
| Audio only | `?layers=bulletins&audio=bulletins`, or the program alone with `?audio=program` | nothing |

The compositor never restreams YouTube's player. Routes live in `station/routes.json`. A route
switches on when its variables are set, and stream keys stay in the environment, never in the
repo or the log.

### Open feeds (CORS `*`, no auth)

| Feed | What it is |
|---|---|
| `/station/feed/schedule.json?hours=24` | the lineup and the next 24 hours of slots |
| `/station/feed/now.json` | what's on and how far in, for syncing |
| `/station/feed/events.json?since=N` | bulletins, skips, rule changes |
| `/station/feed/live` | the same, pushed (Server-Sent Events) |
| `/station/feed/rules.json` | what the station is listening for, published |
| `/station/media/<id>.mp4`, `/station/audio/<file>.mp3` | the files themselves, with range requests |

**Filter** the frame with `?layers=` and `?audio=`. **Fork** it by hosting `public/station.*`
anywhere. **Connect** it to another station with `?feed=https://another.station`.
**Layer** it with `bg=transparent`.

## The schedule

`station/programs.json` lists the episodes (all 17 so far, about 63 minutes) with a 6-second
ident between them.
- **It's anchored.** The loop starts from a fixed instant, so every viewer computes the same
  "now playing" from the clock. The server keeps no playback state.
- **The frame stays in sync.** It corrects any drift over 2.5 seconds.
- **Adding YouTube ids.** Put each video id in the `youtube` field and the web frame plays from
  YouTube.

## Trigger rules

| Kind | Fires on |
|---|---|
| `from` | a new post by a handle (retweets excluded) |
| `mention` | a post that mentions a handle, by someone else |
| `reply` | a reply to a handle |
| `keyword` | a post containing a phrase |

Rules live in `DATA_DIR/station/rules.json` and are published at `/station/feed/rules.json`.
They change only through a programming contract.

### Programming them by voice (the HumAIn loop)

1. **Speak.** Send a WAV to `POST /api/station/program` as `{"audio_b64": …}`, or type it as
   `{"text": …}`. The CLI equivalent is `station program --voice-file f.wav` (or `--text`).
2. **Transcribe.** Meta `muse-voice-transcribe-1.0` is used when `MODEL_API_KEY` is set,
   otherwise ElevenLabs speech-to-text. The audio is dropped after transcription.
3. **Get a contract.**
   - **Parser:** Meta Spark when keyed; otherwise a deterministic parser at $0, which ignores
     phrasing it doesn't understand.
   - **The contract shows:** the rules you have, the rules you'd have, the exact changes, the
     voice budget and the acceptance checks.
4. **Approve.** `POST /api/station/program/P-0001/approve` (or `station approve P-0001`) applies
   the rules and verifies each check against what's on disk. A contract proposed against rules
   that have since changed is refused.

"Leonardo, watch tenso. React whenever someone mentions me or replies to me, and listen for the
phrase 'bloom party'." becomes `from:distributedkv`, `mention:leo_guinan`, `reply:leo_guinan` and
`keyword:bloom party`. Names map to handles through `station/aliases.json`; "me" is
`STATION_OWNER`.

## Reactions: autonomous, with rules

A bulletin airs without review, so what it may say and how often it may say it are fixed in code:

- **What's said.**
  - **The script is a template, not improvised.** Mrs. Bus announces it. Borges reads the post as
    written, without links. Agnolo says: "Public post, quoted as written. Not verified by us."
    Leonardo reacts to the event, never to the claim.
  - **The card says so:** "Automated bulletin. Public post, quoted as written. Aired without
    review."
- **What's skipped.** Each skip is logged, with the reason, and shown on the wire as "not aired":
  - retweets;
  - link-only posts;
  - posts too short or too long;
  - anything touching grief, illness, violence, self-harm or sex, because personal threads stay
    out;
  - handles on `STATION_DENY`.
- **How often.**
  - Each rule has a cooldown.
  - At most 24 bulletins a day, and at most 3 about any one account.
  - Each new post is tried against every rule it matches, most specific first: reply, mention,
    from, keyword.
- **What it costs.**
  - Voices come from ElevenLabs, with a hard daily character cap (`STATION_DAILY_CHARS`).
  - Every voiced line is cached by voice and text. Repeated lines, like Agnolo's label and Mrs.
    Bus's openers, cost nothing after the first time.
  - Over the cap, or without a key, bulletins still air with captions only.

## Where posts come from

- **The Community Archive MCP** (`STATION_ARCHIVE_MCP_URL`, optional token): the same
  `ca_account_tweets` and `ca_search_tweets` used to research the episodes.
- **Late posts.** Posts can reach the archive hours after they're written, so each poll looks
  back `STATION_LOOKBACK_HOURS` and skips posts it has already seen.
- **New rules don't replay the past.** A new rule starts listening when it's created, unless
  `STATION_BACKFILL_HOURS` is set.
- **A fixture** (`STATION_ARCHIVE_FIXTURE`, a JSON file of posts with `release_at`) replays
  posts for demos and tests.

## The demo

[`submission/the-station/station-demo.mp4`](submission/the-station/station-demo.mp4) is 3:05
recorded by the compositor itself, the same path that pushes to YouTube, writing to a file.

**What happens:**
1. Leonardo's programming request becomes four rules, which appear on the wire.
2. Four real posts from the Community Archive arrive and air:
   - Jessyka's reply;
   - tenso's latest post;
   - strangestloop's reply, which airs as a mention because the reply rule was cooling down;
   - tenso's Bloom-party post, which airs on the keyword because the `from` rule was cooling
     down.
3. A retweet is skipped, and the wire says why.

**What was simulated:**
- The posts came from a fixture that released them on a timer; the live server asks the MCP.
- The request was typed, not spoken.
- The cast's lines were voiced in this session through the ElevenLabs connector and loaded into
  the voice cache with `station voice-cache`. On the server, the same lines go through
  `ELEVENLABS_API_KEY`.

## Not done yet

- The watcher has run against the fixture only, not the live Community Archive MCP. That needs
  its URL and key.
- No stream has been pushed to YouTube or Twitch, because that needs your keys. The compositor
  has run end to end, to a file.
- Voice programming hasn't run against live speech-to-text (Meta or ElevenLabs).
- The episodes aren't on YouTube yet, so `programs.json` has no video ids and the web frame
  plays the station's own files.
- Bulletins are cards and voices over the frame. They aren't animated scenes yet.
