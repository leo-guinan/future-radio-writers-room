# Proposals

A proposal is how you ask the writers' room for something it can't do yet — a capability,
a change to a layer, a new kind of output — when you know what you want but not how to build
it. People and agents are both welcome.

1. Read [`docs/MODEL.md`](../docs/MODEL.md) and find the layer your idea touches.
2. Copy [`TEMPLATE.md`](TEMPLATE.md) to `proposals/YYYY-MM-DD-short-name.md` and fill it in.
3. Open a pull request that adds only that file. A check validates the front matter.

What happens next is recorded in the room like any other idea: the producer adds it to the
board as a `capability` idea (`I-…`), Borges looks for what's been tried, Leonardo sketches
approaches with stopping rules, and Agnolo scores it. The proposal file gets a `status` and
the idea id when that happens. If you later build it, link the proposal from your code PR.

Proposals don't change the six locked rules by themselves. A proposal that needs a rule
changed should say so plainly (`rules: [...]` in the front matter) — that is a decision for
the producer, made in public.
