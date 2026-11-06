# The Swarm Test

**Video:** [`the-swarm-test.mp4`](the-swarm-test.mp4), 5:20. For Jessyka Boatright (@jessyka_boat), who told Leo to ask
Annalea Layton (@annalea_l) whether she'd like to be his cofounder.

## What it shows

- **Two replies.** Annalea: "He will throw ideas. My swarm and me will build anything in seconds." Jessyka: "Awww this makes me
  happy. You two will go bonkers!!! I'm curious to see what you both create together."
- **Jessyka's record**, from Leo's side of the Community Archive:

  | When | What she did |
  |---|---|
  | Jun 2025 | Coding-night vlogs |
  | Jul 2025 | Told Leo to offer a fractional CTO service to vibe coders; built the site that "packaged" him ("Leo Translator") |
  | 2025 | One of the first through his program |
  | Oct 2026 | Leo wrote that she "took my philosophy and ran with it" and inspired him to enter a hackathon |
  | Nov 2026 | Pointed him at Annalea |

  "Thank you, Jessyka."
- **The hackathon.** Nous Research's Hermes Agent Plugin Hackathon: 7 days, $20,000, entries due Nov 11 at 5 PM EST.
- **The idea.** Put Future Radio in a Hermes plugin: seven steps, seven tools, script to screen.
- **Two tests.**
  - Forward: the plugin must produce this episode. Agnolo's tolerances are line order exact, each line within 0.5 s, each card
    within 0.5 s, runtime within 1 s.
  - Backward: given only the prompt and the architecture, can Annalea's swarm reverse engineer the episode? It is scored by
    the same test.
- **The dispatch.** A public starter repo to fork. Nothing is owed: "an invitation, not a contract."

## The starter repo

[leo-guinan/future-radio-hermes](https://github.com/leo-guinan/future-radio-hermes) (MIT; a copy is in [`future-radio-hermes/`](future-radio-hermes/)) holds:

- the Hermes plugin;
- the exact spec;
- the recorded takes and cards;
- `PROMPT.md`, `ARCHITECTURE.md` and `REVERSE.md`;
- the acceptance test.

**Test 1 passes.** `python3 acceptance/forward.py` runs the seven tools on the script, the recorded takes and the cards, and
scores the result: 74/74 lines within 0.01 s, 12/12 cards, runtime 320 s, measured from the mp4. The plugin's renderer is a
plain one (cards, voices and subtitles); the acceptance test checks timing, not pixels.

## Notes

- **Who speaks.** Annalea and Jessyka don't speak. Their replies appear as screenshots, and the rest of Jessyka's record
  comes from Leo's public posts.
- **No partnership has been agreed.** The repo is an invitation.
- **Nous Research** hasn't seen or endorsed the film or the repo.
