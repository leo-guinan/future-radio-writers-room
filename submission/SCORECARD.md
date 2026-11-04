# Self-assessment: HumAIn OS — Meta Global AI Developer Hackathon

Scored by us against the published judging process, on the evidence in this folder.
This is our own estimate, not a judge's score.

Rubric: the official Stage Two table (Impact 30%, Use of Meta AI Tooling 25%, Technical Depth &
Execution 20%, Demo 25%), each scored 0–10.

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
- **Risk:** in the *recorded run*, the execution step is HumAIn OS's own Frame Maker, not a Meta
  model. Meta image generation is not used.

## Stage Two — scores (0–10, weighted)

| Category (weight) | Score | Why |
|---|---|---|
| **Impact (30%)** | **7** | Real need: artists choosing between versions of their work, with audience help, while keeping their own tools and audiences. The entry is filed under the **Build for Your World** problem statement. There is now evidence of a real person helped ([`IMPACT.md`](IMPACT.md)): an artist publicly asked for marketing that "someone else does for you". Future Radio made an episode about his work, and he responded unprompted: "I just watched historical artists discuss my whole deal". Held back: that is one person, the posts have small reach, and the episode came from the Future Radio pipeline, not a HumAIn OS run. No audience has used Frame Maker yet. |
| **Use of Meta AI Tooling (25%)** | **8** | Meta tooling is used at three layers. **Built:** Muse Code on Muse Spark wrote the whole system: 12 commits from one session, with a public redacted export that has 15,286 records ([`BUILT_WITH.md`](BUILT_WITH.md)). That work included fixing a restart bug it found in a live run. **Runs:** Voice Transcribe and Spark turn the spoken request into a costed change contract with 17 acceptance tests, enforced by code rather than trusted as prose. **Recursive:** two of those commits came from HumAIn sessions that changed HumAIn's own codebase. This is a clean, verifiable record of Meta's harness engineering a non-trivial system inside its own ecosystem. Held back: the video shows the runtime layer, and the build layer is evidenced only in documents. Meta image generation is not used. |
| **Technical Depth & Execution (20%)** | **8** | Sound, refined engineering. Deadlines run on a monotonic clock, and spend ceilings, a watchdog and stop/revoke are enforced in code. Results land in a hash-chained event log that can be replayed. Unpriced Meta usage is booked as **unknown**, never $0. Restart recovery and atomic frame-ID allocation exist; 43/43 HumAIn tests pass. The live mode fails visibly instead of silently swapping in mocks. Held back: the unsupervised step is a fixed frame builder, not model-driven work. |
| **Demo (25%)** | **7** | Cool to watch and under 3 minutes (2:57). The hosts' recorded voice is the system's actual input, and the run on screen is live: transcript → plan → approval → execution → 17/17 acceptance tests pass → served frames. Held back: the real UI is small inside the animation. The footage is cut out of order and partly sped up (labelled on screen). It is one run. |
| **Weighted total** | **7.5 / 10** | 0.30×7 + 0.25×8 + 0.20×8 + 0.25×7 = 7.45. History: 6.65 at first; 7.15 after the Muse Code build record; 7.45 after the impact evidence and naming the problem statement. |

**Form answers:** [`FORM.md`](FORM.md). They carry the build record and the impact evidence into
the fields judges actually read.

**Biggest lever now:** *Demo* (25%, scored 7). Reach on the impact story would also help: a public
link to the Loopy exchange in the video's post, or a second person, would move Impact more than
any code change could today.

## Stage Three — demo-video risk

- **For us:** under 3 minutes (2:57); memorable; the record → plan → evidence arc is easy to follow;
  the end card says exactly which models ran.
- **Against us:** the real UI appears inside an animation. Judges who want to read the contract or
  the results table will find the text small. The cut is not in chronological order: the frame
  appears before the results table.

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
