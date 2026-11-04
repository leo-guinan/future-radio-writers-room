# Third Take: one note, one fix, and the thread becomes a workshop

**Video:** [`third-take.mp4`](third-take.mp4), 1:52. This is posted as a reply under Second Take.

## The revision (live, Nov 4)

1. **The note.** Leonardo's spoken note for take 2 was the microphone input of a live HumAIn OS
   session, as in Second Take:
   > "Take three. In scene four, Borges says 'here is the evidence' over the finished frame. Put the
   > results table back under that line. Change nothing else."
2. **The edit.** Meta Voice Transcribe transcribed the note, and `muse-spark-1.3` proposed **1 edit**:
   `set_monitor` on scene 4.
3. **The checks.** The session ran unattended: **9/9 acceptance checks pass, 48/48 voice lines
   reused, 0 new recordings.** It published `take3.cut.json`.
4. **The render.** Only **3 of 18 chunks** were re-rendered (15 reused). Video render took **46 s**;
   the whole take took 85 s including audio.

The trend across takes: 3 edits → 1 edit, 6 → 15 chunks reused, 157 s → 46 s of video rendering.

**What the fix actually shows.** Spark moved scene 4 to the end of the run: the ledger and the frames
registry. That is evidence of the run, but it is not the acceptance-results table Leonardo asked for.
The edit validated and the checks passed. Whether it is the *right* picture is a judgment call for the
next note.

## The workshop: our pledge (stated in the episode)

- **How it works.** Until Nov 8, 11:59 PM ET, the thread is a workshop. People comment ideas (an
  artist, a tool, a story), and we make videos from them in the open.
- **If we win the Most Viral prize:** 50% goes to the people whose ideas we make, and 50% seeds a
  next contest.
- **If we don't:** the same amount is recorded as a public debt on Story.markets, to be repaid from
  future earnings. The obligation is ours.

This is our own pledge. It is not a Meta prize and not a sweepstakes. The amounts depend on the
outcome stated above.

## Evidence in `live-capture/`

| File | Contents |
|---|---|
| `humain-events.jsonl` | Hash-chained session log. |
| `state.json` | Final session state. |
| `revision.json` | The edit and its acceptance results. |
| `marks.json` | Screen-recording timestamps. |
| `take3.reuse.json` | Measured chunk reuse. |
