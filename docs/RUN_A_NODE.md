# Run an Art Bus Workshop node

A node is a verifying replica: it pulls the workshop log from the coordinator,
checks the hash chain before serving anything, serves the read API + MCP + web
page, and sends a signed heartbeat every 60 seconds.

## 1. Link your X account and register

Sign in at the coordinator in a browser (`/workshop` → Sign in with X), then
register the node. Registration carries your energy declaration and payout
profile, signed with the node key (use your browser's session cookie):

```bash
# 1. Print a signed registration body (creates the node keypair on first run).
DATA_DIR=./node-data npm run workshop:node -- print-register \
  --url http://YOUR_HOST:8788 \
  --watts 65 --source "rooftop solar" --evidence https://YOUR_PLUG_LOG \
  --budget-wh 5000 \
  --qi 0.5 --quai 0.3 --fiat 0.2 --schedule now > reg.json

# 2. Register (fractions must sum to 1; schedule: now, lump_at:<date>, or
#    stream:<n>x<P1D|P7D|P30D>). Your payout profile can change until close.
curl -X POST http://localhost:8787/api/workshop/nodes/register \
  -H 'content-type: application/json' \
  -H 'cookie: workshop_session=PASTE_YOURS' \
  -d @reg.json
# → {"nodeId":"N-0001", ...}
```

Watts and source are self-attested: the evidence link is recorded for audit,
not verified. The energy budget is your lease: it ends when your receipted Wh
reaches it.

## 2. Run it

```bash
DATA_DIR=./node-data npm run workshop:node -- --upstream http://localhost:8787 --node-id N-0001 --port 8788
```

One command. The node verifies the upstream chain first and refuses to serve
if it does not verify. It re-pulls every 15 s and heartbeats every 60 s.

## What operators earn

- Players who sign in through your node's page are attributed to your node
  (first binding is permanent; your own account never counts toward it).
- Your node's weight is `sqrt(attributed players)`, counted only while its
  uptime is at least 50% of the window since it registered. The square root
  gives diminishing returns: many mid-sized neighborhoods out-earn one giant.
- Rewards come from the pledge: if Future Radio wins the Most Viral prize, the
  participants' share (50%) splits into a player pool and an operator pool
  (`nodeOperatorShareOfParticipants`, set by the producer before nodes are
  advertised). Operators earn their pool pro rata by weight. Until the producer
  sets it, the API reports it as "not set" — never as 0.
- Everything is **projected** until the prize outcome is `won` or `lost`.
- If the prize is lost, there is no payout: the same amount is recorded as a
  public debt on Story.markets, to be repaid from future earnings.

Watch your node at `http://YOUR_HOST:8788/workshop` and
`http://YOUR_HOST:8788/api/workshop/nodes`.
