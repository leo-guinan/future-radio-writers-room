# Submission: HumAIn OS — Meta Global AI Developer Hackathon (Indie track)

- **Video:** [`going-viral.mp4`](going-viral.mp4). 2:57, 1280×720. The Future Radio episode
  "Going Viral". The studio monitor plays the recorded live HumAIn OS session H-0001.
- **Script:** [`going-viral-script.md`](going-viral-script.md).
- **Evidence for the run in the video:** [`live-capture/`](live-capture/).
  - `humain-events.jsonl`: the session's hash-chained event log.
  - `state.json`: final session state, including the Spark plan, the contract, the acceptance
    tests and the results.
  - `marks.json`: when each step happened in the screen recording.
  - `screen.json`: how the monitor footage was cut into the episode.
- **Self-assessment:** [`SCORECARD.md`](SCORECARD.md).

## What the video shows, exactly

Leonardo's command was recorded once, as an ElevenLabs voice clip, and that clip has two jobs. It
is his line in the episode, and it was fed into a headless Chromium browser as the microphone for
`http://localhost:8787/humain`, with the server in live mode (`HUMAIN_LIVE=1`).

From there the session ran on its own:

1. **Meta Voice Transcribe** (`muse-voice-transcribe-1.0`) transcribed the take.
2. **Muse Spark** (`muse-spark-1.3`) wrote a five-task change contract with 17 acceptance tests.
3. The plan was approved with a $5 ceiling and a 300 s compute deadline.
4. HumAIn OS executed it with no further human input. Result: *"Verified state reconciliation:
   17/17 acceptance tests pass. 5 tasks, 0 repairs."*
5. Three comparison frames (F-0001 to F-0003) were served with independent visitor counts.

Cost and time:

- Spark usage came back without a price, so its cost is booked as unknown, never as $0.
- Human time charged: 22 s of the 600 s reserved.

How the footage is edited:

- **Order:** the monitor footage is cut out of order. The finished frame appears before the
  results table.
- **Speed:** parts are sped up or slowed. A label on the monitor says when.
- **Command:** the command itself plays at real time.

Reproduce: the run follows `DEMO.md` §4 in this repository, driven by `tools/capture_humain.py`
and `tools/viral_live.sh` in
[future-radio-studio](https://github.com/leo-guinan/future-radio-studio/tree/test-cut-001-scene-log).
No keys, raw audio or personal data are committed here.
