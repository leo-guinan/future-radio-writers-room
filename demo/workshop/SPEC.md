# The Art Bus Workshop: a time-limited game, API and MCP

Fourth Take (Future Radio) announces this. During the Meta hackathon's Most Viral window, the X thread
becomes a workshop:

1. People **request** games or videos, each with an incentive.
2. Verified players **vote** on the requests.
3. Future Radio **builds** the winners in public.
4. **Agnolo keeps score.**

It runs on volunteer **nodes**, and the people who host them earn part of the rewards.

Everything is an event in an append-only, hash-chained log. The scoreboard, the rewards and the node
uptime are all derived from that log, never stored separately.

## The window

- `opensAt`: when the coordinator first starts. `closesAt`: **2026-11-08T23:59:00-05:00**. Both live
  in `demo/workshop/config.json`.
- **Close is enforced in code.** After `closesAt` every write returns `409 workshop_closed`.
- At close the coordinator appends one `workshop.closed` event containing the final scoreboard
  snapshot and its hash.

## Roles

- **Coordinator.** The one node holding the X app credentials. It accepts writes: sign-in, ideas,
  votes, node registration and heartbeats. It is the source of truth for the log.
- **Node.** Anyone can run one: `npm run workshop:node -- --upstream <coordinator url>`. A node:
  - pulls `/api/workshop/events?since=` from upstream;
  - **verifies the hash chain** before serving anything;
  - serves the full read API and the MCP server;
  - sends a signed heartbeat every 60 s.

  Its operator links an X account at the coordinator, so the rewards go to a verified person.
- **Producer.** Future Radio (holds `PRODUCER_TOKEN`). It records builds, the "we made it" events,
  with a link to each video or game.

## Identity: X OAuth 2.0 (PKCE)

- Endpoints: `GET /api/workshop/auth/x/start`, then `GET /api/workshop/auth/x/callback`. Use the
  scopes `users.read tweet.read` and call `GET /2/users/me?user.fields=created_at`.
- **Keep only** the X user id, handle and account creation date. Discard the access token right after
  verification and never log it. Sessions are a signed httpOnly cookie.
- **One player per X user id.** Accounts created less than 30 days before `opensAt` can play but are
  flagged `new_account` on the scoreboard. They are not blocked.
- Credentials come from env: `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_CALLBACK_URL`, `WORKSHOP_SECRET`.
  If any is missing, auth routes return `503 x_auth_not_configured`. No fallback login exists.

## Game objects

| Object | Fields | Rules |
|---|---|---|
| Idea | `id, author (x id), kind: "game" \| "video", title ≤ 80, pitch ≤ 500, incentive ≤ 200, createdAt` | Players must be verified. At most 3 ideas per player. |
| Vote | `ideaId, voter, weight` | Each verified player has **10 vote points** to spread across ideas, with at most 5 on one idea. They can be moved until close. |
| Build | `ideaId, url, note, builtAt` | Producer only. |
| Node | `nodeId, operator (x id), url, publicKey` | Heartbeats are signed with the node key. A node counts as "up" for a minute when its heartbeat arrives within 90 s. |

## Agnolo's score (derived from the log; the rules live in config so they are visible)

| Event | Points |
|---|---|
| Idea submitted | 1 to the author |
| Vote points received | 1 per point, to the idea's author |
| Idea built | 25 to the author |
| Node uptime | 1 per full hour up, to the operator |

The scoreboard shows each player's handle, total points and the breakdown above, plus the
`new_account` flag.

## Rewards (the pledge from Third Take; amounts are never hardcoded)

`config.json` holds:

```json
{ "pledge": { "ifWin": { "participants": 0.5, "nextContest": 0.5 },
              "ifLose": "public debt on Story.markets, repaid from future earnings",
              "nodeOperatorShareOfParticipants": null,
              "prizeOutcome": "pending" } }
```

- `nodeOperatorShareOfParticipants` must be set by the producer before nodes are advertised. The API
  reports `null` as "not set", never as 0.
- `GET /api/workshop/rewards` computes a **projected** split from the scores: the participants' share
  divided pro rata by points, with node operators paid from their share. It labels the result
  `projected` until `prizeOutcome` is `won` or `lost`.

## HTTP API (JSON)

| Method | Route | What it does |
|---|---|---|
| GET | `/api/workshop` | Status: open/closed, `closesAt`, countdown, pledge, counts, chain head hash. |
| GET | `/api/workshop/ideas?sort=votes\|new` | List ideas. |
| GET | `/api/workshop/ideas/:id` | One idea. |
| POST | `/api/workshop/ideas` | Submit an idea (auth). |
| PUT | `/api/workshop/votes` | Set the full vote allocation (auth): `{ideaId: weight}`. |
| GET | `/api/workshop/scoreboard` | Agnolo's scoreboard. |
| GET | `/api/workshop/players/:handle` | One player. |
| GET | `/api/workshop/rewards` | Projected or final reward split. |
| GET | `/api/workshop/events?since=<seq>` | Raw hash-chained events. |
| GET | `/api/workshop/verify` | Re-verifies the whole chain: `{ok, head, count}`. |
| GET | `/api/workshop/nodes` | Nodes and their uptime. |
| POST | `/api/workshop/nodes/register` | Register a node (auth, operator). |
| POST | `/api/workshop/nodes/heartbeat` | Signed heartbeat. |
| POST | `/api/workshop/builds` | Record a build (producer token). |

## MCP server (read-only; stdio, plus Streamable HTTP at `/mcp`)

Tools:

- `workshop_status`
- `list_ideas(sort, limit)`
- `get_idea(id)`
- `scoreboard(limit)`
- `get_player(handle)`
- `rewards()`
- `recent_events(since, limit)`
- `verify_chain()`
- `list_nodes()`
- `how_to_play()`: returns the sign-in URL and the rules. Writes require signing in with X in a
  browser, so the MCP server never takes credentials.

Every tool result carries `asOf` (event seq and time) and `closesAt`.

## Web page `/workshop`

- Big countdown.
- "Sign in with X".
- Submit-an-idea form.
- Vote sliders showing the 10-point budget.
- Agnolo's scoreboard in large type, readable on camera.
- Node list.
- The pledge text, word for word.

## Tests (must pass)

- Close enforcement.
- One player per X id.
- Vote budget rules: a total of 10, at most 5 per idea, reallocation.
- Idea limit.
- Score derivation from a fixture log.
- Chain verification, including detecting a tampered event.
- Node replica refuses an upstream with a broken chain.
- Heartbeat signature check.
- Reward projection with `null` operator share.
- Auth routes return 503 without credentials.
- MCP tools return `asOf`.

## Deliverables

- The code.
- `demo/workshop/config.json`.
- `docs/RUN_A_NODE.md`: one command, then what operators earn, and that rewards depend on the
  prize outcome or the Story.markets debt.
- A `Dockerfile`.

---

# v2 (Fifth Take): node attribution, workshares, SOAP-style split, sharding

These changes **supersede** the Agnolo score table and the reward projection above.

## Attribution: players belong to the node they came through

- Every node page links to the coordinator's sign-in as
  `/api/workshop/auth/x/start?via=<nodeId>`. The `via` value travels inside the signed OAuth
  `state`, so only the coordinator needs X credentials.
- On a player's **first** successful sign-in, the coordinator appends `player.attributed
  {player, nodeId}`. The binding is permanent.
- If there is no `via`, or it names an unknown node, the player is attributed to `coordinator`.
- An operator's own X account never counts toward their own node.

## Workshares: every verified comment in the thread

- A signed-in player submits the URL of a comment they posted:
  `POST /api/workshop/workshares {url}`.
- The coordinator verifies it with X's public oEmbed endpoint
  (`https://publish.twitter.com/oembed?url=`), which needs no API keys:
  - the `author_url` handle must equal the signed-in handle;
  - the tweet's snowflake timestamp must fall between `opensAt` and `closesAt`;
  - the same URL is never counted twice.
- Thread membership is **asserted by the player and auditable**: the URL is in the public ledger.
  The producer can void a workshare (`workshare.voided {url, reason}`).
- Cap: `workshareCapPerDay` (default 5) counted workshares per player per ET day. Extra ones are
  logged but not counted.

## The split (inspired by Quai: workshares paid in proportion; SOAP routes outside value back in)

Inputs:
- `R`: the reward that comes in from outside the game. It is the prize if we win, or the same amount
  booked as Story.markets debt if we don't.
- `nextContest`: the share that seeds the next contest (0.5).
- `operatorShare`: `nodeOperatorShareOfParticipants`, set by the producer. `null` means "not set".

Pools:
- Participants: `P = R × (1 − nextContest)`.
- Operators: `O = P × operatorShare`.
- Players: `W = P − O`.

How each pool is paid:
- **Players (`W`).** Pro rata by **weight** = counted workshares + `blockBonus` × builds. A build is
  the "block": a player's idea that Future Radio actually made. `blockBonus` defaults to 10. So it
  is not winner-take-all, and every counted workshare earns.
- **Operators (`O`)**, which also rewards sharding. A node's weight is `sqrt(attributed players)`,
  counted only if its uptime is at least 50% of the window since it registered. The square root
  gives diminishing returns, so many mid-sized neighborhoods out-earn one giant one.
- `GET /api/workshop/rewards` returns per-player and per-node projections, with the formula and every
  input. It stays `projected` until `prizeOutcome` is set.

## New and changed API / MCP

- `POST /api/workshop/workshares` (auth).
- `GET /api/workshop/workshares?player=`.
- `GET /api/workshop/nodes/:id/players`, a count only, never a list of handles.
- MCP tools:
  - add `workshares(player)`;
  - add `node_standings()`;
  - `rewards()` now explains the formula.

## Tests (added)

- Attribution is first-binding-only, and the operator's own account is excluded.
- oEmbed author mismatch is rejected (use a mocked fetch).
- Out-of-window and duplicate URLs are rejected.
- The daily cap is applied.
- The void removes the workshare's weight.
- The sqrt node weight and the uptime threshold are applied.
- The pool arithmetic sums exactly to `R`.

---

# v3: the producer's node is n = 1

Leo runs a basic node and does not recruit. His node admits exactly one player, himself, and his
weight is fixed. Every other share of the player pool is earned by engagement.

## Config (`demo/workshop/config.json`)

```json
{ "producerNode": { "nodeId": "producer", "allow": ["<Leo's X user id>"], "maxPlayers": 1,
                    "fixedPlayerWeight": 1, "operatorWeight": 1 },
  "noViaPolicy": "reject" }
```

## Rules

- **Only Leo can sign in through the producer node.** A sign-in through it (or through the
  coordinator, if Leo hosts that) by any account not in `allow` is refused with `403
  sign_in_through_a_community_node`. The response lists the registered community nodes with their
  sign-in links, so the refusal points people to nodes run by others.
- **Signing in with no node.** `noViaPolicy: "reject"` (the default) refuses a sign-in that names no
  node, in the same way. `"unassigned"` lets the player in and attributes them to no node: they earn
  as players, but no operator earns for them. Switch to it only if there are no community nodes yet.
- **Leo's player weight is always `fixedPlayerWeight` (1).** It does not depend on how many
  workshares he submits, how many builds he gets, or how many votes he receives. He can still play;
  it just never raises his weight.
- **The producer node's operator weight is always `operatorWeight` (1)**, which equals
  `sqrt(1)`. Its uptime still has to meet the 50% threshold.
- **Every other player's weight is earned:** counted workshares + `blockBonus` × builds, exactly as
  in v2.

## What the API and MCP show

- `GET /api/workshop/rewards` and the MCP tool `rewards()` show the producer row explicitly, with
  `weight: 1 (fixed)` and `n: 1`, so anyone can check Leo isn't taking more than one share.
- `node_standings()` lists the producer node with `n = 1 (capped)`.

## Tests (added)

- A second account signing in through the producer node is refused, and the response lists the
  community nodes.
- With `noViaPolicy` set to `reject`, a sign-in with no node is refused. With `unassigned`, the
  player is admitted with no operator credit.
- Leo's weight stays 1 after he submits many workshares and has a build.
- The producer node's operator weight stays 1.
- Pool arithmetic still sums exactly to `R`, with the producer included.

---

# v4: energy-bound nodes (see `EXPERIMENT.md`)

- **`POST /api/workshop/nodes/register`** gains new fields:
  - `energy: {watts, source, evidenceUrl, budgetWh}`;
  - `payout: {qi, quai, fiat, schedule}`, where the three fractions sum to 1 and `schedule` is one
    of `now`, `lump_at:<ISO date>` or `stream:<n>x<P1D|P7D|P30D>`.

  The body is signed with the node key.
- **`POST /api/workshop/nodes/payout`** sets `payout.profile.set` (auth, signed). It is final at close.
- **Hourly derived `energy.receipt` per node:** Wh = watts × hours up (from verified heartbeats),
  plus the work counts. The receipt is derived and then **appended** to the log, so it is fixed at
  creation.
- **Energy TTL.** A node's lease ends when its receipted Wh reaches `budgetWh` (`node.lease.ended`,
  reason `energy_budget`) or when the event closes.
- **Generation requests are priced in workshares.** `POST /api/workshop/generate {ideaId}` spends
  `generateCostWorkshares` (in config) from the requester's counted workshares. It never charges
  money.
- **`GET /api/workshop/settlement`** returns, per operator: the computed share, the payout profile,
  and the schedule rendered as dated amounts. Until the prize outcome is known it is labelled
  `obligation`, never `paid`. Nothing executes transfers.
- **MCP:** add `energy_receipts(node)` and `settlement()`.
- **Tests:**
  - payout fractions must sum to 1;
  - the energy-budget TTL ends the lease;
  - receipt Wh comes from heartbeats only, never from claims;
  - spending workshares on generation reduces player weight correctly;
  - settlement is reproducible from the log on a node.
