# Going Viral: take 1 → take 2

3 edits · 48/48 lines reused · 0 new recordings

## 1. set_monitor s2 (fixes F1)

Feedback: The real UI is too small to read the contract and the results table.

Why: Add a tighter crop to the contract span so the text is large enough to read.

- before: from {"mark":"contract","off":0} to {"mark":"execute","off":0.6} crop null
- after: from {"mark":"contract","off":0} to {"mark":"execute","off":0.6} crop [240,135,800,450]

## 2. set_monitor s3 (fixes F1)

Feedback: The real UI is too small to read the contract and the results table.

Why: Repoint this span to the results table with a tighter crop so the results are large enough to read in chronological position.

- before: from {"mark":"frame","off":0} to {"mark":"frame","off":5} crop null
- after: from {"mark":"done","off":0.6} to {"mark":"done","off":6.4} crop [240,135,800,450]

## 3. set_monitor s4 (fixes F2)

Feedback: The monitor footage is out of chronological order with the finished frame appearing before the results table.

Why: Repoint this span to the finished frame so the frame plays after the results in chronological order.

- before: from {"mark":"done","off":0.6} to {"mark":"done","off":6.4} crop null
- after: from {"mark":"frame","off":0} to {"mark":"frame","off":5} crop [240,135,800,450]
