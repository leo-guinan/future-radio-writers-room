# Second Take: the first cut, revised by Meta Muse Spark

**Video:** [`second-take.mp4`](second-take.mp4), 2:27. A Future Radio episode reviewing our own submission video.

## What happened, in order (all live, Nov 4)

1. **Take 1.** The rough cut of *Going Viral* was stored as data:
   [`demo/cuts/going-viral/take1.cut.json`](../../demo/cuts/going-viral/take1.cut.json).
2. **The spoken note.** Leonardo's note was recorded once, as an ElevenLabs voice clip. That same clip
   was the microphone input of a live HumAIn OS session (`HUMAIN_LIVE=1`, `/humain?cut=going-viral`):
   > "I've watched the rough cut of Going Viral. The screen is too small to read, and the frame
   > appears before the results. Keep everything that works. Make the fewest changes that fix those
   > two, and show me what you would change."
3. **Transcription.** Meta Voice Transcribe transcribed the note.
4. **The edits.** Muse Spark (`muse-spark-1.3`) proposed **3 edits**, all `set_monitor`: crop in on
   the contract, put the results table in scene 3, and put the frame after it.
5. **Validation.** Code validated the edits against the cut schema. The session executed unattended:
   **11/11 acceptance checks pass, 48/48 voice lines reused, 0 new recordings.** It published
   `take2.cut.json`, `edits.json` and `diff.md`.
6. **Take 2.** The studio rendered take 2 from `take2.cut.json`, re-rendering only the chunks whose
   content changed: **6 of 18 ten-second chunks reused**. Video render took 157 s; a full render is an
   estimated 235 s.
7. **A note for take 3.** The episode points out a real flaw in take 2. In scene 4, Borges now says
   "here is the evidence" over the frame instead of the results. That is a note for take 3, so we ask
   the audience for theirs.

## Evidence in `live-capture/`

| File | Contents |
|---|---|
| `humain-events.jsonl` | Hash-chained session log. |
| `state.json` | Final state: plan, contract, results. |
| `revision.json` | Edits and acceptance results. |
| `marks.json` | Screen-recording timestamps. |
| `take2.reuse.json` | Measured chunk reuse. |

## Two honest notes

- **The live session found a real bug.** Spark's reasoning used about 8.3k tokens, which exhausted
  the 8,000-token budget, so the reply came back empty. The strict live mode refused to invent edits
  and failed visibly. The fix is commit `c785cf1` (raise the budget, request JSON). The second run is
  the one shown.
- **Who built what.** Muse Code built the cut-revision mode (commits `c044dec`..`9613aab`). The studio
  renderer, the cut file format and this episode were made with Claude.
