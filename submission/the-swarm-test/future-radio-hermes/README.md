# Future Radio × Hermes: The Swarm Test

A starter repo. Fork it and see what your swarm can do with it.

[Future Radio](https://github.com/leo-guinan/future-radio-writers-room) makes short animated episodes from a script. This repo
packages its production process as a [Hermes Agent](https://hermes-agent.nousresearch.com/) plugin: seven tools from script to
screen, and an acceptance test.

It accompanies the episode **The Swarm Test** (5:20). Watch the reference film in the
[writers' room](https://github.com/leo-guinan/future-radio-writers-room/blob/review/humain-os-prototype/submission/the-swarm-test/the-swarm-test.mp4).

## Why this exists

- **Jessyka** ([@jessyka_boat](https://x.com/jessyka_boat)) told Leo to reach out to **Annalea**
  ([@annalea_l](https://x.com/annalea_l)) about being his cofounder.
- Annalea replied: "He will throw ideas. My swarm and me will build anything in seconds."
- This repo is the idea Leo is throwing.

## The two tests

| | Test 1: forward | Test 2: backward (the swarm test) |
|---|---|---|
| **Who** | the plugin | your swarm |
| **Given** | the script, the recorded takes, the cards and the cue sheet | [`PROMPT.md`](PROMPT.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md), nothing else |
| **Makes** | the episode | the script, the cards and the timing (a `timeline.json`), then the episode |
| **Scored by** | `acceptance/accept.py` | the same test, `--mode reverse` |

Agnolo's tolerances (from the film):

- line order: exact;
- each line starts within 0.5 s;
- each card appears within 0.5 s;
- total runtime within 1 s.

Test 1 passes today. Test 2 is open; see [`REVERSE.md`](REVERSE.md).

## Quick start

```bash
pip install pyyaml pytest playwright && python3 -m playwright install chromium   # ffmpeg must be on PATH
pytest                                    # unit checks on the plugin and the acceptance test (instant)
python3 acceptance/forward.py             # test 1, end to end: the seven tools make the episode, then it's scored (~2 min)
```

Expected end of `forward.py`:

```
PASS  line order (exact)           74 of 74 lines
PASS  line starts within 0.5s      74/74; worst 0.01s
PASS  card starts within 0.5s      12/12
PASS  runtime within 1.0s          320.00s vs 320s (measured from the mp4)

forward: PASS
```

In Hermes (`plugin.yaml` is at the repo root):

```bash
hermes plugins install <you>/future-radio-hermes
hermes plugins enable future-radio
hermes plugins doctor future-radio --ci
```

Then ask the agent to make the episode from `spec/lines.tsv`. It has these tools:

| Tool | Step |
|---|---|
| `fr_script` | 1. The script becomes a table: an id, a speaker and a line. |
| `fr_voice` | 2. One take per scene per character. Reuses `spec/takes`; generating new takes needs `ELEVENLABS_API_KEY`. |
| `fr_split` | 3. Each take is cut at its longest silences, one clip per line. |
| `fr_prep` | 4. Each clip is trimmed, levelled and sped up 4%. |
| `fr_cards` | 5. Monitor cards are HTML pages, photographed. |
| `fr_timeline` | 6. Every line and card goes on the clock. |
| `fr_render` | 7. Frames, mix, film. |
| `fr_accept` | The acceptance test. |

## What's in the repo

| Path | What it is |
|---|---|
| `plugin.yaml`, `__init__.py`, `schemas.py`, `tools.py` | The Hermes plugin. |
| `pipeline.py` | The seven steps as plain functions. Needs only the standard library and ffmpeg; cards also need Playwright. |
| `spec/episode.json` | The exact spec: every line's text, speaker, start and duration; every card's start; title, credits, runtime, voices and tolerances. **It is the answer key for test 2.** |
| `spec/lines.tsv`, `spec/takes/`, `spec/cards/` | The script, the 24 recorded takes (ElevenLabs eleven_v4) and the 12 monitor cards. |
| `acceptance/` | `accept.py` (score any timeline), `forward.py` (test 1, end to end). |
| `prompt/` | The three screenshots that came with the prompt. |

## What's real, and what's a starter

- **Voice is the one step that isn't deterministic.** A new take has new timing, so test 1 runs on the recorded takes. Every step
  after that is deterministic, and the durations match the studio's to the frame.
- **The renderer is plain.** The reference film was rendered by the Future Radio studio: the animated cast, the camera, the
  music. `fr_render` makes cards, voices and subtitles instead. The acceptance test checks the spec (order, timing, cards,
  runtime), not the pixels. A better renderer is a good first PR.
- **The cue sheet** (the gaps between lines and what each card hangs on) is read from the spec in test 1. In the studio those
  beats are written by hand. Writing them from the script is part of test 2.

## Notes

- **It's an invitation, not a contract.** Nobody owes anything, and no partnership has been agreed.
- **Who speaks.** Annalea and Jessyka don't speak in the film. Their public replies appear as screenshots.
- **Nous Research** runs the Hermes Agent Plugin Hackathon: entries are due 5 PM EST on Nov 11, 2026. Nous Research hasn't seen
  or endorsed this repo or the film.

## License

[MIT](LICENSE). The screenshots in `prompt/` and in the cards are of other people's public posts, included for the test;
they remain theirs.
