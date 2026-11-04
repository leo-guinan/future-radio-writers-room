# Self-assessment: HumAIn OS — Meta Global AI Developer Hackathon

Scored by us against the published judging process, on the evidence in this folder.
This is our own estimate, not a judge's score.

**Note on the rubric:** the Stage Two rubric table was not available to us when we wrote this, so
the scores below use the three Indie-track criteria from the event page: creativity, technical
ambition, and whether it works. Re-score this against the official table before relying on it.

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

## Stage Two — scores (0–10)

| Criterion | Score | Why |
|---|---|---|
| Creativity | **8** | The demo is an episode. Robot radio hosts speak the request, and that same audio clip is the microphone input the live system transcribes. The argument ("a better paintbrush, not a market competitor") is clear and specific to artists. The animated framing is unusual for a hackathon demo, which cuts both ways. |
| Technical ambition | **7** | Hard enforcement in code: monotonic-clock deadlines, spend ceilings, a watchdog, and stop/revoke from any state. A contract-first loop: desired vs observed state, reuse vs build, acceptance tests. A hash-chained evidence ledger. Honest cost accounting: Meta returns usage without a price, so spend is booked **unknown**, never $0. Held back because the autonomous step is a deterministic frame builder rather than model-driven code generation. |
| Whether it works | **7** | One live end-to-end run on camera: Meta Voice transcription, then a Spark plan (5 tasks), then $5 / 300 s approval, then unsupervised execution, then **17/17 acceptance tests pass**, three frames served over HTTP with visitor counts. 43/43 HumAIn tests pass. Held back because: one run; no reported cost for Spark; and the video shows the session on an in-scene monitor in an edited, partly sped-up order (labelled on screen), so judges see less of the raw UI than in a screen-recorded demo. |
| **Average** | **7.3** | |

## Stage Three — demo-video risk

- **For us:** under 3 minutes (2:57); memorable; the record → plan → evidence arc is easy to follow;
  the end card says exactly which models ran.
- **Against us:** the real UI appears inside an animation. Judges who want to read the contract or
  the results table will find the text small. The cut is not in chronological order: the frame
  appears before the results table.

## What would raise the score before the deadline

1. **Whether it works / ambition.** In the description, add a direct link to `live-capture/`. Quote
   the session's own line: "Verified state reconciliation: 17/17 acceptance tests pass."
2. **Readability.** Attach a 60–90 s raw screen recording of the same session as a second video,
   if the form allows one. The capture already exists.
3. **Precision.** In the form, state plainly: Voice and Spark ran live via the Meta Model API;
   execution is local and deterministic; Muse Code and image generation are next.
