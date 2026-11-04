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
- **Risk:** judges may expect Meta models in the *execution* step. In this run the execution was
  HumAIn OS's own Frame Maker. Muse Code and Meta image generation are described in our copy but
  were not exercised in this video.

## Stage Two — scores (0–10, weighted)

| Category (weight) | Score | Why |
|---|---|---|
| **Impact (30%)** | **6** | Real need: artists choosing between versions of their work, with audience help, while keeping their own tools and audiences. HumAIn OS already builds the comparison frames and counts unique visitors (excluding refreshes and automated checks). Held back: no artists or audiences have used it yet. "Find the hundred who would pay" is a goal, not a result. We also have not checked the entry against the event's listed problem statements, which this rubric asks about. |
| **Use of Meta AI Tooling (25%)** | **6** | Two Meta models ran live in the recorded session. Voice Transcribe turned the spoken request into text. Muse Spark turned it into a structured, costed change contract: desired vs observed state, reuse vs build, 17 acceptance tests. Spark's output is enforced by code, not trusted as prose. Held back: transcription and planning are fairly standard uses. Muse Code and Meta image generation are in our copy but were not used in this run. Nothing here is likely to "surprise" Meta. |
| **Technical Depth & Execution (20%)** | **8** | Sound, refined engineering. Deadlines run on a monotonic clock, and spend ceilings, a watchdog and stop/revoke are enforced in code. Results land in a hash-chained event log that can be replayed. Unpriced Meta usage is booked as **unknown**, never $0. Restart recovery and atomic frame-ID allocation exist; 43/43 HumAIn tests pass. The live mode fails visibly instead of silently swapping in mocks. Held back: the unsupervised step is a fixed frame builder, not model-driven work. |
| **Demo (25%)** | **7** | Cool to watch and under 3 minutes (2:57). The hosts' recorded voice is the system's actual input, and the run on screen is live: transcript → plan → approval → execution → 17/17 acceptance tests pass → served frames. Held back: the real UI is small inside the animation. The footage is cut out of order and partly sped up (labelled on screen). It is one run. |
| **Weighted total** | **6.7 / 10** | 0.30×6 + 0.25×6 + 0.20×8 + 0.25×7 = 6.65 |

**Biggest lever:** *Use of Meta AI Tooling* (25%) is where we are thinnest relative to its weight.
Getting a Meta model into the execution step, not only the planning step, would lift both that
score and Impact. That means Muse Code writing the change, or Meta image generation producing the
competing versions artists compare. Even one more live stage shown on the monitor would help.

## Stage Three — demo-video risk

- **For us:** under 3 minutes (2:57); memorable; the record → plan → evidence arc is easy to follow;
  the end card says exactly which models ran.
- **Against us:** the real UI appears inside an animation. Judges who want to read the contract or
  the results table will find the text small. The cut is not in chronological order: the frame
  appears before the results table.

## What would raise the score before the deadline

1. **Use of Meta AI Tooling.** Wire Meta image generation into Frame Maker, so the competing
   versions are generated, then re-run live. The adapter seam (`MetaImageGen`) already exists. This
   is the highest-weighted gap we can still move today.
2. **Demo.** In the description, link `live-capture/` and quote "17/17 acceptance tests pass". If
   the form allows a second video, attach the 60–90 s raw screen recording of the same session, so
   judges can read the contract and results.
3. **Impact.** In the copy, name the event's problem statement this addresses, and describe one
   concrete artist workflow: post two cuts, share the frame, read the unique-visitor counts.
