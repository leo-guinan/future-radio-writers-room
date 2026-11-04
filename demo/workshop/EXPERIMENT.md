# Experiment: energy-bound validation nodes (Nov 5–8, 2026)

**Question.** Can work and energy that are measured, and recorded when they happen, serve as an
anchor for future payment? And can access to compute be priced in creativity instead of money?

**Who.** Quai / Qi miners and other operators from aligned decentralized networks. Each hosts a
temporary validation node for the workshop game (`npm run workshop:node`) for the length of the
event.

## What gets measured, and when

Everything is appended to the workshop's hash-chained log **at the time it happens**. That is what
lets it be paid later: the record is fixed and validated at creation.

| Record | Fields | How it's validated |
|---|---|---|
| `node.registered` | node id, operator X id, public key, **energy declaration** (watts, source, evidence link), payout profile | X sign-in. The operator signs the declaration with the node key. |
| `node.heartbeat` | events verified, requests served, chain head | Ed25519 signature. The coordinator checks the chain head it reports. |
| `energy.receipt` (hourly per node) | Wh = declared watts × hours actually up; work done (verifications, requests); source claim | Derived from the signed heartbeats. Watts and source are **self-attested**: the evidence link (pool stats, a smart-plug log, a utility statement) is recorded, not verified. |
| `payout.profile.set` | `{qi, quai, fiat}` fractions summing to 1; schedule `now` \| `lump_at:<date>` \| `stream:<n>x<interval>` | Signed by the operator. Can be changed until close. The last one before close is final. |

## Energy, not time, sets the TTL

- A node lease is an **energy budget**, not an expiry date. At registration the operator declares
  how many Wh they commit, e.g. 5 kWh.
- The lease ends when the node's cumulative receipted Wh reaches that budget, or when the event
  closes, whichever comes first.
- Unused budget is simply not receipted.
- The same idea can apply to any credit in the game: it lives until a given amount of receipted
  energy has passed through the network, not until a date.

## Compute costs creativity, not money

- Nodes are free to run against and free to query.
- When a player asks the workshop to **generate** something (a game or a video), it is priced in
  **workshares**, the player's verified comments, not in dollars.
- The energy receipts show what that generation consumed. So creativity buys compute, and the ledger
  shows the energy behind it.

## Settlement

- **At close (Nov 8, 11:59 PM ET)** the coordinator computes each operator's share. The formula is the
  v2/v3 rules: sqrt-weighted, the producer node fixed at n = 1.
- **The outcome is then recorded against the pledge.** If we won, it is paid from the prize. If we
  didn't, it is a Story.markets debt, still recorded per operator with that operator's payout profile.
- **Payouts follow each operator's profile:** the Qi / Quai / fiat breakdown, paid now, as a lump on
  a date, or as a stream.
- **Execution is not automatic in this experiment.** The obligation, amounts and payout instructions
  are computed automatically and are public and verifiable. Sending crypto automatically needs a
  funded, custodied wallet and a payout service; that is the next phase, not this week.

## What this experiment does not do (yet)

- **It does not issue transferable credit.** Energy receipts are non-transferable records. Letting
  anyone issue credit backed by programmable energy is a financial instrument, and needs legal and
  tax review before it exists.
- **It does not verify that energy is clean.** It records the operator's claim and their evidence,
  so a later process can audit it.
- **Players never need a wallet.** The game itself has no tokens, as Fifth Take says. Only node
  operators who choose a Qi/Quai payout give an address, and only at settlement.

## Success criteria (measured at close)

1. The number of independent operators and nodes, and their cumulative receipted Wh.
2. Every receipt re-verifies from the log (`/api/workshop/verify`).
3. Settlement reproduces exactly from the log by anyone running a node.
4. The amount of generation paid for in workshares rather than money.
