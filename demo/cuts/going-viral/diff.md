# Going Viral: take 2 → take 3

1 edits · 48/48 lines reused · 0 new recordings

## 1. set_monitor s4 (fixes F1)

Feedback: Scene 4 v4_036 'Here is the evidence' plays over the finished frame instead of the results table.

Why: Moves scene 4 picture from finished-frame time back to results-table time under v4_036.

- before: from {"mark":"frame","off":0} to {"mark":"frame","off":5} crop [240,135,800,450]
- after: from {"mark":"done","off":6.4} to {"mark":"frame","off":0} crop [240,135,800,450]

## Declined

- F2 (Keep take 2 legibility fixes (crops) and chronological order.): No crop or order change made; edit preserves take 2 crops and chronological order.
