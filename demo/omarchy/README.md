# HumAIn OS live demo inside Try Omarchy

Reproducible Meta-powered demo in the Try Omarchy VM (stock Omarchy,
Arch ARM). The guest runs the server; the guest browser runs the
microphone path (Mac mic is bridged by Try Omarchy).

## One-command demo

```bash
demo/omarchy/install.sh                 # once per machine (clean install)
demo/omarchy/start-demo.sh --live       # THE demo command (needs MODEL_API_KEY)
```

`start-demo.sh` verifies the install, launches the server in the
foreground, and prints the checklist URLs. Anything missing fails
visibly with the fix.

## Live-demo checklist

Host (macOS, person):

- [ ] Try Omarchy app open, VM booted, first-boot setup finished.
- [ ] Launcher → Network: SSH forward on Mac `127.0.0.1:2222` → guest `:22`.
- [ ] Launcher → Network: forward Mac `127.0.0.1:8787` → guest `:8787`
      (only if a Mac browser should reach the demo too).
- [ ] Microphone granted to Try Omarchy (launcher prompts, or System
      Settings → Privacy & Security → Microphone).
- [ ] `MODEL_API_KEY` exported where the demo server runs (guest shell).
      Never commit it, paste it into the UI, or store it in the log.

Guest (Omarchy terminal):

- [ ] `demo/omarchy/install.sh` → `PASS: installed`.
- [ ] `MODEL_API_KEY=... demo/omarchy/start-demo.sh --live` → server up.
- [ ] New terminal: `demo/omarchy/verify.sh` → `ALL CHECKS PASSED`.
- [ ] Browser: `http://localhost:8787/humain` → open session (2 min),
      tick Meta Voice, Start recording, speak, Stop recording →
      transcript arrives from `muse-voice-transcribe-1.0` (failure shows
      the provider error; nothing is substituted).
- [ ] Close input → Make plan (`muse-spark-1.3` in live mode) →
      review contract → Approve ($5, 300s) → Execute → `done`.
- [ ] Terminal: `humain replay`, `humain evidence`, `humain frames`,
      `humain budget` show the recorded trail.

## Recording procedure (reproducible)

1. Fresh shell, `cd` to the repo, `export DATA_DIR=/tmp/humain-rec`.
2. `./demo/omarchy/record.sh` — captures replay/evidence/frames/budget
   of the fixture log into `demo/omarchy/recordings/demo-<ts>.log`.
3. Run the live mic session (checklist above) in a second shell; the
   server log is the execution record.
4. After `done`, re-run `record.sh -- humain evidence H-0003`
   (or the new session id) to capture the fresh evidence.
5. Review recordings for personal data, then keep or publish.

## Evidence map

| Question | Command | Meaning |
|---|---|---|
| What did Meta actually charge? | `humain evidence` → OBSERVED | Receipts with evidence refs |
| What did we predict? | `humain evidence` → ESTIMATED | Forecasts, never receipts |
| What has no price? | `humain evidence` → UNKNOWN | Usage without a price |
| What did the human spend? | `humain evidence` → TIME / `humain budget` | Charged seconds vs 60-min budget |
| What did the machine spend? | `humain evidence` → TIME | Autonomous seconds, separate |
| What was reused vs built? | `humain evidence` → CAPABILITIES | Reuse list vs build list |

## Fixtures

`fixtures/` holds the recorded H-0001/H-0002 log and frame F-0001 from
the 2026-11-02 live run (36K, secret-scanned). `install.sh` stages them
only into an empty data dir and never overwrites history.

## Verified 2026-11-02 (Try Omarchy 1.2.0, Omarchy guest, aarch64)

- Clean install: clone + `npm ci` + typecheck + 42/42 humain tests.
- Server launch, `/healthz` chain verify, all read-only humain routes.
- Browser mic path (headless Chromium, file-fed fake mic): MediaRecorder
  → WAV export → `/audio` → live `muse-voice-transcribe-1.0` → ingested
  chunk (sessions H-0005, H-0006). Visible failure without a server key
  (API 400) and as a browser dialog on a closed session.
- Full live loop (Spark `muse-spark-1.3` direct): H-0009 done 7/7.
- Restart reconstruction: SIGKILL mid-approved-session → all limits,
  decisions, spend, ownership preserved → H-0010 executed to done 7/7.
  (This caught and fixed a real bug: restarts orphaned task ownership.)
- Time accounting: H-0010 charged 23s human of 600s reserved, 0s
  autonomous (sub-second execution rounds to 0).
- Recording: `demo/omarchy/recordings/demo-20261103-074826.log`.

Person-led, not agent-verified: physical microphone take, host-browser
access via the 8787 forward (needs `sudo ufw allow 8787/tcp` in the
guest — the stock firewall blocks it).
