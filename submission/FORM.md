# Submission form answers (paste-ready)

Meta Global AI Developer Hackathon. Deadline: Nov 4, 2026, 9:00 PM ET.

---

### Which track are you submitting to?

**Indie track**

### Which problem statement did you build towards?

**Build for Your World**

### If you're competing for the Most Viral Track, please submit your X post link here

**Link to the X post of *Second Take*** (`submission/second-take/second-take.mp4`). We are
entering this prize: the post is the revised take of our demo, and it asks the audience for the
next note and for who to make an episode for.

### Project Description

HumAIn OS: voice-first agent sessions with a human time budget.

Artists and independent builders do not run out of ideas. They run out of time and attention, and
most of the internet only looks for them when there is money to be made. HumAIn OS is built on
one contract:

- the human has a time budget;
- the machine has a resource budget;
- success means verified change, not a claim that the work is done.

How a session works:

1. You choose a window of 2 to 60 minutes and speak. Meta Voice Transcribe turns the speech into
   text.
2. Muse Spark turns the transcript into a change contract: desired vs. observed state, what to
   reuse vs. build, acceptance tests, cost estimates and spending limits.
3. When the window closes, input stops. The approved plan executes with no further human
   attention.
4. Tests run, failures get bounded repairs, and every result, cost and artifact lands in a
   hash-chained event log that can be replayed.
5. Blocked or over-budget runs stop at a checkpoint and never claim silent success.

All of this is enforced in code, not prompts: monotonic-clock deadlines, budget gates, a watchdog,
stop/revoke, and booking unpriced usage as unknown rather than $0.

The demo app is Frame Maker, which lets an artist put competing versions of their work in front of
an audience and count unique visitors, separately from refreshes and automated checks.

Our demo video is an episode of our show, Future Radio. Leonardo da Vinci speaks the command. That
exact recording was the microphone input of a live HumAIn OS run, and the run plays on the studio
monitor:

- transcript → Spark contract → approval → unattended execution;
- 17/17 acceptance tests pass;
- three live comparison frames are served.

After submitting, we gave our own demo notes. HumAIn OS turned Leonardo's spoken note into 3
validated cut edits with Muse Spark, reused all 48 voice lines and re-rendered only the changed
chunks: about 5 minutes from note to take 2, instead of a new episode. That is *Second Take*
(`submission/second-take/`), our Most Viral post.

Human impact so far: Future Radio made an episode about an artist (@strangestloop) and his public
call for help. His response: "I just watched historical artists discuss my whole deal… it's great
to see how the technology has advanced." Evidence is in `submission/IMPACT.md`.

### Public GitHub Repository

https://github.com/leo-guinan/future-radio-writers-room/tree/review/humain-os-prototype

(Start at `submission/README.md`. Build provenance:
https://github.com/leo-guinan/meta-hackathon-proof-of-work)

### 3-Minute Demo Video

`submission/going-viral.mp4` (2:57). Link to an uploaded copy (YouTube or similar) if the form
needs a playable URL. The repo file is at:
https://github.com/leo-guinan/future-radio-writers-room/blob/review/humain-os-prototype/submission/going-viral.mp4

### Describe your use of Meta products to build the submitted project

Meta tooling is used at three layers.

1. **Built with Meta.** HumAIn OS was engineered end to end in **Muse Code** (1.4.14), Meta's
   coding harness, running **muse-spark-1.3-contributor**. One session wrote every HumAIn OS
   commit: the prototype, change contracts, the reconcile loop, the tests, the demo bundle, and a
   restart bug that Muse Code found during a live run and fixed. The full redacted session export
   (15,286 records) and a commit-by-commit timeline are public at
   github.com/leo-guinan/meta-hackathon-proof-of-work.
2. **Runs on Meta.** At runtime the Meta Model API powers the system:
   - **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`) converts the spoken request into text,
     using realtime WebSocket and multipart upload.
   - **Muse Spark** (`muse-spark-1.3`, via `/chat/completions`) turns it into a structured, costed
     change contract with acceptance tests. Code enforces the contract; it is not trusted as prose.
   - In live mode, if Meta's APIs are unavailable the run fails visibly instead of swapping in
     mocks.
3. **The same loop on our own demo.** Muse Code built a cut-revision mode in about 14 minutes
   (5 commits, 9 tests). Spark then used it live: from Leonardo's spoken note on our first cut to
   3 schema-valid edits, 11/11 acceptance checks and take 2 (`submission/second-take/`).
4. **Built by itself.** Two of the commits came from HumAIn OS sessions running on Meta models,
   which changed HumAIn OS's own code during development. The changes were visit classification
   and frame totals.

### Why are Meta's models important to your solution?

The point of HumAIn OS is that people should own the systems that spend their time. That has to
apply to us first. We have built on other people's models, and our own development flow should run
on models and tools we can manage within one ecosystem.

Meta gives us the whole loop in one place: speech in (Voice Transcribe), reasoning and planning
(Spark), and the coding harness that builds the system (Muse Code). This hackathon is the start of
moving our development flow onto Meta. HumAIn OS is the first system built entirely that way, and
we published the complete session record to prove it.

What the models do in the product:

- Voice is the lowest-cost way for a person to state what they want.
- Spark turns that speech into a contract structured enough for code to enforce.

Without both, the human time budget would be a slogan, not a guarantee.
