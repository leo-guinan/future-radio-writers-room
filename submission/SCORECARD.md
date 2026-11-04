# Self-assessment: HumAIn OS — Meta Global AI Developer Hackathon

Scored by us against the published judging process, on the evidence in this folder.
This is our own estimate, not a judge's score.

Rubric: the official Stage Two table (Impact 30%, Use of Meta AI Tooling 25%, Technical Depth &
Execution 20%, Demo 25%), each scored 0–10.

## What we are submitting: two takes

| | Video | Role |
|---|---|---|
| **Submission demo** | *Going Viral*, [`going-viral.mp4`](going-viral.mp4), 2:57 | The take we judged good enough to submit: a live HumAIn OS run on the studio monitor. |
| **Most Viral post (X)** | *Second Take*, [`second-take/second-take.mp4`](second-take/second-take.mp4), 2:27 | The same video put through review and revised under deadline by Meta models. It ends by handing the final note to the audience. |

Together they show the compression this project is about: the gap between "good enough to submit"
and "we have a deadline, but we'd like one more revision".

Measured times on Nov 4 (from `second-take/live-capture/` and the commit log):

| Step | Time |
|---|---|
| Leonardo's spoken note (the human input) | 13 s |
| Muse Spark turns it into 3 validated cut edits | 103 s |
| Unattended execution, 11/11 acceptance checks | under 1 s |
| Take 2 re-render (6 of 18 chunks reused; full render ≈ 235 s) | 183 s, including audio |
| **From note to take 2** | **≈ 5 minutes** |
| Muse Code building the cut-revision mode itself (5 commits, 9 tests) | about 14 minutes |
| *Making a new episode instead* | *most of a day* |

All 48 voice lines were reused, with no new recordings. Take 2 is not perfect: one line now plays
over the wrong footage. The episode says so and turns it into the note we ask the audience for.

## Stage One — baseline viability (pass/fail)

**Expected: PASS.**

- **Fits the theme.** *Build for Your World* (artists choosing what to publish, with audience help),
  with a *Push the Frontier* angle (a verified autonomous run inside human time and spend budgets).
- **Used the Meta Model API during the hackathon (live, observed):**
  - `muse-voice-transcribe-1.0` transcribed the spoken request from the browser microphone. That
    take is in the recorded screen footage; the model id was confirmed by a separate one-shot +
    realtime check on the same clip, run just before.
  - `muse-spark-1.3` produced the plan and change contract (`state.json` → `plan.planner`).
  - Session `H-0001` is in `live-capture/humain-events.jsonl`, hash-chained.
- **Built with Meta's coding harness:** every HumAIn OS commit was written in one Muse Code 1.4.14
  session on `muse-spark-1.3-contributor`. The redacted session export is public; see
  [`BUILT_WITH.md`](BUILT_WITH.md).
- **Second live session (Second Take):** Meta Voice Transcribe and `muse-spark-1.3` revised the cut.
  The evidence is in `second-take/live-capture/`. The cut-revision mode itself was built by Muse Code.
- **Risk:** in the *Going Viral* run, the execution step is HumAIn OS's own Frame Maker, not a Meta
  model. In Second Take, Spark's edits are the work product, but a renderer applies them. Meta image
  generation is not used.

## Stage Two — scores (0–10, weighted)

| Category (weight) | Score | Why |
|---|---|---|
| **Impact (30%)** | **7** | Real need: artists choosing between versions of their work, with audience help, while keeping their own tools and audiences. The entry is filed under the **Build for Your World** problem statement. There is now evidence of a real person helped ([`IMPACT.md`](IMPACT.md)): an artist publicly asked for marketing that "someone else does for you". Future Radio made an episode about his work, and he responded unprompted: "I just watched historical artists discuss my whole deal". Held back: that is one person, the posts have small reach, and the episode came from the Future Radio pipeline, not a HumAIn OS run. No audience has used Frame Maker yet. |
| **Use of Meta AI Tooling (25%)** | **8.5** | Meta tooling is used at three layers. **Built:** Muse Code on Muse Spark wrote the whole system: 12 commits from one session, with a public redacted export that has 15,286 records ([`BUILT_WITH.md`](BUILT_WITH.md)). That work included fixing a restart bug it found in a live run. **Runs:** Voice Transcribe and Spark turn the spoken request into a costed change contract with 17 acceptance tests, enforced by code rather than trusted as prose. **Recursive:** two of those commits came from HumAIn sessions that changed HumAIn's own codebase. This is a clean, verifiable record of Meta's harness engineering a non-trivial system inside its own ecosystem. **New today:** Muse Code built a second capability, cut revision, in about 14 minutes. Spark then used it live to revise our own demo: from a spoken note to 3 schema-valid edits, with 48/48 lines reused. Held back: the submitted demo video shows only the runtime layer; the build layer and Second Take are evidenced in the repo and the X post. Meta image generation is not used. |
| **Technical Depth & Execution (20%)** | **8.5** | Sound, refined engineering. Deadlines run on a monotonic clock, and spend ceilings, a watchdog and stop/revoke are enforced in code. Results land in a hash-chained event log that can be replayed. Unpriced Meta usage is booked as **unknown**, never $0. Restart recovery and atomic frame-ID allocation exist; 43/43 HumAIn tests pass. The live mode fails visibly instead of silently swapping in mocks. **New today:** episodes are now data (`cut.json`) and revisions are a closed set of validated edit operations. Rendering is incremental, using per-chunk content signatures, and the reuse report is measured. Strict live mode caught a real failure, an empty Spark reply caused by the reasoning-token budget, instead of inventing edits; the one-line fix is commit `c785cf1`. Held back: in Going Viral the unsupervised step is a fixed frame builder; in Second Take a renderer outside HumAIn applies the edits. |
| **Demo (25%)** | **7** | Cool to watch and under 3 minutes (2:57). The hosts' recorded voice is the system's actual input, and the run on screen is live: transcript → plan → approval → execution → 17/17 acceptance tests pass → served frames. Held back: the real UI is small inside the animation. The footage is cut out of order and partly sped up (labelled on screen). It is one run. |
| **Weighted total** | **7.7 / 10** | 0.30×7 + 0.25×8.5 + 0.20×8.5 + 0.25×7 = 7.675. History: 6.65 at first; 7.15 after the Muse Code build record; 7.45 after the impact evidence and naming the problem statement; 7.68 after Second Take. |

**Form answers:** [`FORM.md`](FORM.md). They carry the build record and the impact evidence into
the fields judges actually read.

**Why Demo stays at 7:** judges score the submitted video, which is Going Viral, unchanged. Second
Take shows how we would fix that video's faults, but it is not the submitted demo. If judges follow
the link to it from the description, Demo could reasonably read as 7.5–8, which would make the
weighted total about 7.8–7.9.

**Biggest lever now:** reach. The Most Viral prize is judged on engagement, not on this rubric, and
Impact is our heaviest category. Comments that nominate artists feed both: every nominee is a
potential next episode and a second person helped.

## Most Viral Project (separate prize: likes, reposts and comments on X by Nov 8, 11:59 PM ET)

We cannot predict this score from the work. Our recent posts reached 27–715 views. What could make
it travel is the mechanism, not the video's quality:

- the audience is asked for the take 3 note and for **who to make an episode for**;
- every nominee who gets an episode has a reason to repost it, as Loopy did.

The X post link goes in the form's Most Viral field.

## Stage Three — demo-video risk

- **For us:** under 3 minutes (2:57); memorable; the record → plan → evidence arc is easy to follow;
  the end card says exactly which models ran.
- **Against us:** the real UI appears inside an animation. Judges who want to read the contract or
  the results table will find the text small. The cut is not in chronological order: the frame
  appears before the results table. *Second Take is our answer to both faults, and the one revision
  it introduces is stated openly.*

## What would raise the score before the deadline

1. **Use of Meta AI Tooling.** Put the build record in the description: "HumAIn OS was built
   entirely in Meta's Muse Code harness on Muse Spark; full session export at
   github.com/leo-guinan/meta-hackathon-proof-of-work." Optional further step: wire Meta image
   generation into Frame Maker (the `MetaImageGen` seam exists) and re-run live.
2. **Demo.** In the description, link `live-capture/` and quote "17/17 acceptance tests pass". If
   the form allows a second video, attach the 60–90 s raw screen recording of the same session, so
   judges can read the contract and results.
3. **Impact.** Done: the problem statement is named (Build for Your World) and human-impact
   evidence is added. Next: describe one concrete artist workflow (post two cuts, share the frame,
   read the unique-visitor counts) and run it with a real artist.
