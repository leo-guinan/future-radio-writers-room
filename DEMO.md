# HumAIn OS live demo (reproducible)

A real, observable, Meta-powered state change without continuous human
supervision: Leonardo's spoken request becomes a change contract, approved
code lands from an isolated checkout, and acceptance evidence reconciles.

## Prerequisites

- Node ≥ 20, `npm install` in this repo.
- `MODEL_API_KEY` — Meta Model API key. Server-side only; rotate after demoing.
- A voice WAV: mono, 16-bit, 16 kHz. Convert any recording with
  `ffmpeg -i in.mp3 -ar 16000 -ac 1 -c:a pcm_s16le req.wav`.
  (The original demo used an ElevenLabs voice reading Leonardo's line.)

## 1. Verify the Meta paths (fail visibly or not at all)

```bash
export MODEL_API_KEY=...          # never commit this
node --import tsx scripts/humain-voice-check.mjs req.wav
```

Expect one transcript from the one-shot endpoint and one from the realtime
socket. In live mode nothing falls back silently: missing keys, bad audio, or
unparseable replies are loud errors.

## 2. Run a live frame session (voice → Spark → frames)

```bash
export DATA_DIR=/tmp/humain-demo HUMAIN_LIVE=1
node --import tsx src/cli.ts humain demo --live --voice-file req.wav \
  --ceiling 5 --secs 600 --reserve 10
node --import tsx src/cli.ts humain replay H-0001
node --import tsx src/cli.ts humain frames
```

## 3. Run a live code-change session (the Leonardo demo)

```bash
export DATA_DIR=/tmp/humain-demo-code HUMAIN_LIVE=1
node --import tsx scripts/humain-code-session-voice.mjs req.wav 5 1800 10
# or typed: node --import tsx scripts/humain-code-session-typed.mjs "idea" 5 1800 10
```

This transcribes, drafts a Spark code contract from observed repo state,
approves with ceiling/compute limits, and locks the session for execution.
No human input is accepted past this point.

Implement in an isolated checkout:

```bash
git worktree add /tmp/humain-exec-H -b exec/H-XXXX
cd /tmp/humain-exec-H && ln -s <repo>/node_modules node_modules  # do NOT commit this link
# ... implement, run tests ...
git add <named files> && git commit -m "..."
cd <repo> && git merge --no-ff exec/H-XXXX
```

Record evidence and reconcile (repeat per task; finish needs all acceptance green):

```bash
export DATA_DIR=/tmp/humain-demo-code SESSION=H-0001
node --import tsx scripts/humain-code-record.mjs "H-0001-T1:/tmp/ev-T1.txt" [...]
node --import tsx src/cli.ts humain budget
```

## 4. See it in a browser

```bash
DATA_DIR=/tmp/humain-demo-code npm start
# open http://localhost:8787/humain and http://localhost:8787/api/humain/frames/F-0001
```

## What the reference run proved (2026-11-02)

- Voice file + realtime transcription of Leonardo's request (Meta, live).
- Spark-drafted code contract from observed `frames.ts` (Meta direct, live).
- Visit classification: human/unique/verification counts, legacy migration,
  served pages with live counts (isolated checkout, 41/41 humain tests).
- Reuse run: frames totals via the same classification API, `frames.ts`
  untouched; second Spark contract live.
- Time: H-0001 finished before cross-process accounting was fixed (0s/0s
  recorded, defect noted); H-0002 charged human 11s of 600s reserved,
  autonomous 62s. Meta responses carry no cost fields: usage recorded,
  cost booked unknown — never zero-as-fact.
