# Future Radio cut format (`future-radio.cut/1`) and revision edits

A **cut** is one take of an episode, stored as data. The studio renderer
(`future-radio-studio`, scene `viral`) reads it and draws the episode. A
**revision** is a short list of edits. Applying it to take N produces take N+1,
and the renderer re-renders only the time ranges the edits change.

The fixture is `going-viral/take1.cut.json`, the published rough cut (2:57).

## Cut fields

| Field | Meaning |
|---|---|
| `lines[]` | Spoken lines in playback order: `{id, speaker, text}`. The id prefix `vS_` is the scene (1–5). The order of this array is the edit order. |
| `shots{}` | Named camera framings: `{zoom, x, y}`. Bigger zoom means closer. `MON`, `MON_C`, `MON_R` and `LMON` frame the studio monitor that plays the HumAIn OS recording. |
| `cues[]` | Forced camera shots: `{before: lineId, shot, lead, hold_after, hold_through?}`. The cut moves to `shot` `lead` seconds before the line starts. It holds until that line ends + `hold_after`, or until the end of `hold_through` (a line id, or `"END"`). Lines without a cue use automatic coverage. |
| `monitor[]` | What the monitor shows in each span of the episode: `{span, from:{mark,off}, to:{mark,off}, crop}`. Spans are fixed by the scenes: `s1_tail` runs from after the command to scene 2, then `s2`, `s3`, `s4`, `s5` (to the end). The span's episode time is mapped linearly onto capture time `from` → `to`, so a short span over a long range plays sped up, and `from == to` holds a still. `crop` is `null` (whole screen) or `[x, y, w, h]` in capture pixels (1280×720), which zooms the monitor into that region. |
| `capture.marks` | Seconds into the HumAIn OS screen recording when each step appeared: `record`, `stop`, `transcript`, `contract`, `approve`, `execute`, `done` (results table), `frame` (served comparison frame), `end`. |
| `end_card[]` | End-card text lines. |

## Edit operations (closed set: anything else is rejected)

Each edit is `{op, ...args, why, fixes}`. `why` is one sentence. `fixes` is the
id of the feedback point the edit answers, e.g. `"F1"`.

| op | args | Notes |
|---|---|---|
| `set_monitor` | `span, from, to, crop?` | Change what a span shows. `from`/`to` are `{mark, off}`. Capture time must stay within `[0, marks.end]`. A `crop` aspect ratio must be between 1.5 and 2.0. |
| `set_shot` | `shot, zoom, x, y` | Retune a named framing. `zoom` must be in `[0.8, 3.5]`. |
| `set_cue` | `before, shot, lead?, hold_after?, hold_through?` | Add or replace the cue on a line. |
| `remove_cue` | `before` | |
| `move_line` | `id, after` | `after` is a line id, or `null` for first. The line must stay in its scene. |
| `drop_line` | `id` | |
| `rewrite_line` | `id, text` | **Costs a new voice recording.** Use only when no other edit can fix the feedback. |
| `set_end_card` | `lines[]` | Up to 6 lines, each up to 60 characters. |

## Invariants (the validator enforces these)

- `v1_006` (Leonardo's command, the live microphone input of the recorded run) cannot be moved, dropped or rewritten.
- Referenced ids, shots, spans and marks must exist.
- **At most 6 edits.** Fewer is better: the goal is the smallest change that fixes the feedback.
- Every feedback point is addressed by at least one edit, or explicitly declined with a reason.

## Output of a revision

- `takeN+1.cut.json`: the applied cut.
- `edits.json`: the validated edit list.
- `diff.md`: a human-readable diff showing each edit, the feedback it fixes, and the before/after values.
