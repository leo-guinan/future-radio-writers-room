# The Live Run

A two-episode library (1:55) streamed against thread
[2118414208370905428](https://x.com/leo_guinan/status/2118414208370905428). Both films were recorded by the compositor.

## The films

| Film | Length | What happens |
|---|---|---|
| [`riff-demo.mp4`](riff-demo.mp4) | 5:10 | Jim O'Shaughnessy's quote post starts a riff that runs 2:17. The cast ask the archive 8 questions and get 5 good answers, then it wraps after two dull answers in a row. The repost and the likes that came in meanwhile get short segments. **The library took 4:56 to stream. The thread added 3:01.** |

## The riff on Jim

All the answers are real Community Archive results (`test/fixtures/ask-jim.json`):

| Question | Answer |
|---|---|
| Who is he? | Greenwich and Manhattan, osv.llc, on X since 2009 |
| Has he talked to us before? | Sep 19: "Applications for 2027 open January 1, 2027" (the same date as today's quote) |
| What did Leo say back? | Sep 20: "I'll work on my application!" |
| And from Leo since? | Nov 1: "No movie for Jim yet, but we have a trailer." |
| What's he posting this week? | "Seek out what interests you… Don't be boring." |

Each segment is saved, so a rerun costs nothing: `POST /api/live/reair`.

How it works and what was simulated: [LIVE.md](../../LIVE.md). The repost and like counts were simulated, and the answers came from
the recorded fixture rather than a live archive connection.

**Re-recorded Nov 5.** The first recordings had an echo. The compositor's browser had restored tabs from earlier runs, so two copies
of the page played a few milliseconds apart. Each start now gets a fresh browser profile, and a page silences itself if a newer
copy opens. The 30-second-cap demo was removed; the cap is gone anyway.
