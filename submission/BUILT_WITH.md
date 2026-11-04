# Built with Meta's coding harness: HumAIn OS was written by Muse Code on Muse Spark

Every HumAIn OS commit up to the Nov 3 verification stamp was made in a single **Muse Code** session.
The coding model was Meta's **`muse-spark-1.3-contributor`**. The full redacted session export is
public, so anyone can check this.

**Proof repository:** <https://github.com/leo-guinan/meta-hackathon-proof-of-work>

- `session/dawn-triton.redacted.json`: the full Muse Code session export.
- `TIMELINE.md`: build milestones, cross-referenced to commits.
- `GIT-HISTORY.md`: every HumAIn commit with its files changed.

## What the export shows (checked independently, Nov 4)

| Check | Result |
|---|---|
| Harness | `exporter_version` and `session_build` = **Muse Code 1.4.14 (dec7d7497f)** |
| Coding model | All 15 `run.model.configured` records are `provider_id: meta`, `model_id: muse-spark-1.3-contributor`. No other provider or model is configured. |
| Session | `dawn-triton` (`01a19dab-2a7e-75f1-87a6-f34abd01966e`): 15,286 records, Nov 2 14:10 → Nov 4 13:07 EST, 418 tool batches, 14 human turns |
| Commits | All 12 HumAIn commit hashes below appear in the session's own tool output, for example `[review/humain-os-prototype 4413b83] …` and `c820aba..0c9bba6 review/humain-os-prototype -> review/humain-os-prototype`. All 12 exist on the upstream branch. |
| Key hygiene | The Meta API key is absent from the proof repo (exported with `muse export --redacted`; fragment scan returns 0 matches) |

## Commits written by Muse Code

| Commit | When (EST) | What |
|---|---|---|
| `82454bf` | Nov 2 15:35 | Offline prototype: voice-first, time-bounded sessions |
| `8d77e91` | Nov 2 16:23 | v2: change contracts, reconcile loop, persistent frames, Meta adapters |
| `4413b83` | Nov 2 16:40 | Atomic frame IDs, peek verification, live mode, time accounting |
| `7e483cc`, `9700fa4` | Nov 2 16:43 | Visit classification, **built by a live HumAIn session (H-0001) in an isolated checkout** and merged |
| `760d61f` | Nov 2 16:47 | Session rebuild derives time charges from event timestamps |
| `d5bbf45`, `634bc8d` | Nov 2 16:46–16:49 | Reuse test: frame totals reuse classification without touching `frames.ts` (H-0002) |
| `a2b2543` | Nov 2 16:49 | Demo drivers and live-demo instructions |
| `c820aba` | Nov 2 17:02 | Omarchy demo: Meta voice upload, evidence report, demo bundle |
| `0c9bba6` | Nov 3 07:17 | Restart-ownership fix, **found in a live guest run (H-0008)**, shipped and re-verified |
| `c3657ff` | Nov 3 07:50 | Clean-VM verification stamp |

`d8cde72` (node_modules symlink cleanup, Nov 2 16:43) is also in the same window.

## Added on Nov 4: cut revision, built in a second Muse Code session

| Commit | What |
|---|---|
| `c044dec` | Cut revision domain: validateEdits, applyEdits, diff, contract builder |
| `5e5ddac` | Strict-live Spark cut planner (planRevise), with canned-reply tests |
| `3fba712` | Revise session mode: cut target, cut.edit executor, routes and CLI |
| `dca47d7` | Camera-facing revise UI: cut banner, large-type results panel |
| `9613aab` | Fixture run: a canned Spark revision executes to take 2 on disk |

Muse Code wrote these 5 commits in about 14 minutes, from a written prompt.

One follow-up commit is **not** from Muse Code: `c785cf1` raises the planner's token budget after
the first live run returned empty content. Claude made that fix. It changes one line plus adding a
`response_format` field.

## Why this matters for the entry

Meta's models appear at **three layers**, not one:

1. **Built by Meta.** Muse Code on Muse Spark engineered HumAIn OS end to end: design, tests,
   live-bug fixes, and VM verification. That includes the code that calls Meta's APIs.
2. **Runs on Meta.** At runtime, Meta Voice Transcribe turns the spoken request into text, and
   Muse Spark turns it into a costed change contract with acceptance tests.
3. **Recursive.** Two of the commits above (`7e483cc`/`9700fa4`, `d5bbf45`/`634bc8d`) were
   produced by HumAIn OS sessions while it was being built. In those sessions, a Meta-planned
   contract changed the system's own codebase.

## What Muse Code did not make

The following were made with Claude (Anthropic), not Meta's tooling:

- the pre-existing Future Radio writers' room this branch builds on;
- the Going Viral episode, its studio renderer, and the capture pipeline;
- this `submission/` packaging, scorecard included.

The engineering claim covers HumAIn OS itself: the commits listed above.
