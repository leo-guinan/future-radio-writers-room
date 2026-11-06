# The live run

The library plays once, start to finish, and one thread interrupts it. Each update on the thread
stops the program: the background freezes and the update is announced. Then the cast riff on it,
asking the archive questions about whoever engaged, for as long as the answers stay
interesting. Then the program comes back exactly where it froze. The run ends when the library
does.

Every segment is saved with its audio, so a rerun costs nothing: no questions, no voices.

How long it takes is the measurement: the library's length plus every second the thread took.
A quiet thread finishes on time; an active one takes longer. **The thread's energy becomes
broadcast time.**

## The interrupt

| Phase | What happens | How long |
|---|---|---|
| **freeze** | The picture stops on the current frame, goes grey, and gets a FROZEN badge with the title and timestamp. A sting plays. The cast prepare their reaction (memory and voices) while it holds. | at least 1.5 s, until the reaction is ready |
| **announce** | Mrs. Bus announces the update by type. The card shows the post when there is one. | the line |
| **riff** | The segment is generated live. Borges reads the post and the sentence of the thread that bears on it. Then, each turn, Leonardo or Agnolo asks the archive a question and Borges reads the answer, with the archive call on screen. Lines are generated about 10 s ahead of the voice, so there's no dead air. When the riff wraps, Agnolo books it, Leonardo reacts, and Mrs. Bus files the segment for reruns. | **as long as it's interesting**; safety limit 10 min (`LIVE_RIFF_LIMIT_SECS`) |
| **return** | "And now, back to our regularly scheduled programming." The card says where it resumes. | about 3 s |
| *(resume)* | The program continues from the exact frame where it froze. | |

### Update types

| Type | Announced as |
|---|---|
| `reply` | "A reply, from Steph Curdy." |
| `quote` | "Jim O'Shaughnessy quoted it." |
| `repost` | "One new repost." (the new reposts since the last look are counted together) |
| `like` | "2 new likes." |
| `bookmark` | "3 new bookmarks." |
| `views` | "It just passed 1,000 views." (at milestones) |
| `reair` | "From the archive: a rerun." |

- **The first look is a baseline, not news.** Only changes after the run starts interrupt it.
- **Queueing.** Updates that arrive during an interrupt wait their turn. The wire shows "N more
  queued."

## The riff: questions to the archive

For a person (a reply or a quote), the cast work through:
- **who they are** (`ca_account`);
- **what they've said to Leo** (`ca_search_tweets`, from them);
- **what Leo has said to them** (`ca_search_tweets`, from Leo);
- **what they're posting this week** (`ca_account_tweets`);
- then more from either side.

**Interesting is measured, not judged.**
- An answer counts when it's a post nobody has cited yet that shares words with the update, or
  with the sentence of the thread that names the person. The first answer of each kind ("who is
  this?") always counts.
- A dull answer gets one short line ("6 posts there. Nothing new on this."), not a reading, so
  airtime follows interest.
- Two dull answers in a row and the segment wraps.
- Every quoted post passes the same safety check as station bulletins.

Counts (reposts, likes, views) have no person to ask about. They get a line of the thread and the
ledger.

The questions come from a fixed list, in a fixed order. A model choosing its own questions with
the archive tools is the next step.

**What happened with Jim's quote** (`test/fixtures/ask-jim.json`, real archive answers):

| | Question | Answer |
|---|---|---|
| 1 | Who is he? | Greenwich and Manhattan, osv.llc, on X since 2009 |
| 2 | Has he talked to us before? | Sep 19: "Applications for 2027 open January 1, 2027", the same date as today's quote |
| 3 | What did Leo say to him? | Sep 20: "I'll work on my application!" |
| 4 | Anything else from him? | dull |
| 5 | And from Leo? | Nov 1: "No movie for Jim yet, but we have a trailer." |
| 6 | What's he posting this week? | "Seek out what interests you… Don't be boring." |
| 7–8 | One more from each side? | two dull answers, so it wraps |

That's 8 questions, 5 good answers, and about two minutes on air.

## Reruns

- `GET /live/feed/segments.json` lists the saved segments.
- `POST /api/live/reair {segment}` queues one as an interrupt: the announcement "From the archive:
  a rerun.", then the segment exactly as it aired, from the cached audio.

The first airing pays for the questions and the voices. Every airing after that is free.

## Memory

Borges may only say what a record says, and every memory line carries its record id.
- **Where the records come from:**
  - the episodes' READMEs (what the films said, with their sources);
  - the thread itself;
  - the station's past bulletins;
  - this run's earlier updates.

  Every update is written back, so the next reaction can remember it.
- **How recall works.** Handles, names and words in the update are matched against the records.
  Counts like likes and reposts have no author to remember, so for those Borges reads a line of
  the thread instead.
- **What's fixed in code.** Agnolo's ledger: the type, the count, the interruption number. A reply
  or quote that touches a personal topic is announced but not read aloud.
- **What can improvise.** Leonardo's line, when `ANTHROPIC_API_KEY` is set: one line, about the
  event, never about the person.

## Run it locally and stream to X

1. In X Media Studio, open Producer and create a broadcast source. It gives you an RTMP(S) URL and
   a stream key.
2. Configure `.env`:

   ```bash
   X_RTMP_URL=rtmps://…  X_STREAM_KEY=…
   LIVE_AUTOSTART=1 LIVE_THREAD=2118414208370905428 LIVE_SOURCE=x  # or archive, or push
   ELEVENLABS_API_KEY=…   PRODUCER_TOKEN=…
   ```

3. Start it:

   ```bash
   docker compose up -d                       # the run starts with the server
   STATION_PAGE='/live.html?kiosk=1' docker compose --profile broadcast up -d   # composite and push to X
   ```

   Watch it yourself at `http://localhost:8787/live`.
4. Go live from Media Studio.

### When X shows LIVE but the player stays black

X has opened the broadcast but isn't receiving a stream it can play. Work down this list:

1. **Read the compositor's log.**

   ```bash
   docker compose logs compositor --tail 40
   ```

   - `route x: on → rtmps://…/x/abc…yz` is where it's pushing, with the key masked.
   - `route x: off (X_RTMP_URL, X_STREAM_KEY not set)` means `.env` didn't reach the container.
     Recreate it: `docker compose --profile broadcast up -d --force-recreate compositor`.
   - `error opening`, `Connection refused`, `Input/output error` or `All tee outputs failed` means
     X refused the push. Check the URL and the key. Media Studio's stream key changes when you
     regenerate it.
   - A `frame=… fps=30 … speed=1x` line every 10 s means the stream is flowing.
2. **Send a test pattern.** This uses no browser, only colour bars and a tone:

   ```bash
   docker compose --profile broadcast run --rm -e STATION_TEST_PATTERN=1 compositor
   ```

   - If the bars show up in Media Studio's preview, the path to X works, and the issue is the page
     capture (check `docker compose logs room`).
   - If they don't, the issue is the URL, the key, or the broadcast setup.
3. **Media Studio:**
   - The source must be the one whose key is in `.env`.
   - The broadcast must use that source.
   - Its preview must show the picture before you press **Go Live**.
4. **The URL:** `X_RTMP_URL` is the full ingest URL Media Studio shows, for example
   `rtmps://….pscp.tv:443/x`. A trailing `/` is fine. The key goes in `X_STREAM_KEY` and nowhere
   else.

### Where updates come from

| `LIVE_SOURCE` | What it sees | Cost |
|---|---|---|
| `x` | Live counts (likes, reposts, bookmarks, views), replies by `conversation_id`, quote posts | `X_BEARER_TOKEN`, paid X API tier |
| `archive` | What the Community Archive has observed: the root post's counts, and replies and quotes from archived accounts. It's late and partial: on Nov 5 it had the root post (1 like, 1 repost) but not Jim's quote. | free |
| `push` | Nothing is polled. You, an agent or a bookmarklet send `POST /api/live/update {type, user, name, text, count}` | free |
| `fixture` | A timeline of snapshots, for tests and demos | |

### API

| Call | What it does |
|---|---|
| `POST /api/live/start {thread, source, library?, poll_secs?}` | start a run (producer) |
| `POST /api/live/update` | push one update (producer) |
| `GET /live/feed/state.json` | the whole run, open: phase, position, the current interrupt with its script and phase times, and the ledger |

## Acceptance

`node --import tsx --test test/live.test.ts` drives whole runs on a fake clock:

1. Every interrupt goes freeze → announce → react → return → resume. The program position doesn't
   move during the interrupt and resumes at the frozen frame.
2. The freeze holds at least 1.5 s, and as long as the reaction takes to prepare.
3. The riff holds the air as long as it grows, ends when it wraps, and has a safety limit. On
   Jim's real archive answers, the cast ask several questions and find his September post with the
   same date. Nothing is read twice, dull answers get one short line, and the segment wraps after
   two dull answers in a row.
4. Every update type is announced as itself, including reruns.
5. The run ends with the library. Its length is the library plus the thread's time. An active
   thread takes longer than a quiet one, and the ledger counts interruptions by type.
6. A saved segment re-airs exactly as it aired, with no new archive questions and no new voices.

There are also checks on the thread diffs and on memory recall, citation and the ledger.

## The demo

[`submission/the-live-run/riff-demo.mp4`](submission/the-live-run/riff-demo.mp4) was
recorded by the compositor, the same path that pushes to X, writing to a file. It's a short
library of two episodes and thread `2118414208370905428`.

**What it shows:**
1. Jim O'Shaughnessy's quote post interrupts the first episode.
2. Then a repost.
3. Then two likes, which arrive during the repost interrupt and wait in the queue.
4. The library completes, and the end card gives the total time and how much the thread added.

**What was simulated:**
- The root post's text is from the Community Archive. Jim's quote is as shown on X.
- The updates came from a fixture on a timer, and the repost and like counts are simulated.
- The cast's lines were voiced in this session through the ElevenLabs connector and loaded into
  the voice cache. On your machine they're generated live with `ELEVENLABS_API_KEY`.

## Not done yet

- No live run has used the X API or a real X stream yet. Both need your keys.
- The archive source can't see Jim's quote until the archive does.
- Very busy threads make a long queue. Updates of the same type aren't merged across polls yet.
- The questions follow a fixed plan. A model-driven riff, choosing its own questions with the same
  tools, needs `ANTHROPIC_API_KEY` and is the next step.
