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
