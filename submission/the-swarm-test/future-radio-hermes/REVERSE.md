# Test 2: the swarm test

> "Can her swarm reverse engineer the movie?" "Scored by the same test."

## The rules

1. **Inputs.** Give the swarm [`PROMPT.md`](PROMPT.md), the screenshots in [`prompt/`](prompt/), and
   [`ARCHITECTURE.md`](ARCHITECTURE.md). It may also read public sources the prompt points to (the Community Archive, public
   posts, the Hermes docs).
2. **Keep the answer key closed.** Don't let it see:
   - `spec/` (the answer key);
   - `episodes/` in the Future Radio studio;
   - the reference film.

   Run it on a copy of the repo without them, and say so in your result.
3. **Output.** The swarm writes:
   - `fr-work/script.tsv`;
   - the cards as HTML;
   - `fr-work/timeline.json`, in the schema in ARCHITECTURE.md.

   Card ids `c0`… are matched by position.
4. **Score:**

   ```bash
   python3 acceptance/accept.py fr-work/timeline.json --mode reverse
   ```

5. **Optional: render it.** Record voices with the cast's voice ids, run steps 3, 4 and 7, and pass `--mp4` to check the
   runtime from the film itself.

A blind remake isn't expected to match word for word. The score shows how close it got: speaker order, words, timing, cards
and runtime.

## Open book

Watching the film and transcribing it is a different, easier test. If you run it, label it `open book`.

## Sharing a result

Open an issue or a PR on [leo-guinan/future-radio-hermes](https://github.com/leo-guinan/future-radio-hermes) with:

- the score output;
- what the swarm was given;
- how long it took.

There's nothing to win, and nobody owes anything. It's a game, not a job.
