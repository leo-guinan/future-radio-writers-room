# The live run

The library plays once, start to finish, and one thread interrupts it. Each update on the thread
stops the program: the background freezes, the update is announced, and the cast react for 30
seconds at most. Then the program comes back exactly where it froze. The run ends when the
library does.

How long it takes is the measurement: the library's length plus every second the thread took.
A quiet thread finishes on time; an active one takes longer. **The thread's energy becomes
broadcast time.**

## The interrupt

| Phase | What happens | How long |
|---|---|---|
| **freeze** | The picture stops on the current frame, goes grey, and gets a FROZEN badge with the title and timestamp. A sting plays. The cast prepare their reaction (memory and voices) while it holds. | at least 1.5 s, until the reaction is ready |
| **announce** | Mrs. Bus announces the update by type. The card shows the post when there is one. | the line |
| **react** | Borges reads what was said and what the library remembers, with the record cited on screen. Agnolo books it. Leonardo reacts. A countdown shows the 30-second cap. | **30 s at most**, enforced in code |
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

- **The first look is a baseline, not news.** Only changes after the run starts interrupt it.
- **Queueing.** Updates that arrive during an interrupt wait their turn. The wire shows "N more
  queued."

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
3. A reaction never runs longer than 30 s, even when its lines total 55 s.
4. Every update type is announced as itself.
5. The run ends with the library. Its length is the library plus the thread's time. An active
   thread takes longer than a quiet one, and the ledger counts interruptions by type.

There are also checks on the thread diffs and on memory recall, citation and the ledger.

## The demo

[`submission/the-live-run/live-run-demo.mp4`](submission/the-live-run/live-run-demo.mp4) was
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
