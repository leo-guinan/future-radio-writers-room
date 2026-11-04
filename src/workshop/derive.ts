// Derivation: scoreboard, rewards and node uptime computed from the log, never
// stored. Every function here is pure over (events, config, now).

import type { RoomEvent } from "../core/types.ts";
import type { WorkshopConfig } from "./config.ts";

export interface PlayerView {
  xId: string;
  handle: string;
  createdAt: string;
  newAccount: boolean;
}

export function derivePlayers(events: readonly RoomEvent[], config: WorkshopConfig): Map<string, PlayerView> {
  const out = new Map<string, PlayerView>();
  const opensMs = Date.parse(config.opensAt);
  for (const e of events) {
    if (e.type !== "workshop.player") continue;
    const p = e.payload as { xId: string; handle: string; createdAt: string };
    if (out.has(p.xId)) continue; // one player per X id; the first record wins
    out.set(p.xId, {
      xId: p.xId,
      handle: p.handle,
      createdAt: p.createdAt,
      newAccount: opensMs - Date.parse(p.createdAt) < config.newAccountDays * 86_400_000,
    });
  }
  return out;
}

export interface BuildView {
  ideaId: string;
  url: string;
  note: string;
  builtAt: string;
}

export function deriveBuilds(events: readonly RoomEvent[]): Map<string, BuildView> {
  const out = new Map<string, BuildView>();
  for (const e of events) {
    if (e.type !== "workshop.build") continue;
    const b = e.payload as BuildView;
    if (!out.has(b.ideaId)) out.set(b.ideaId, b);
  }
  return out;
}

/** Latest full vote allocation per voter; points received per idea. */
export function deriveVotes(events: readonly RoomEvent[]): { byVoter: Map<string, Record<string, number>>; byIdea: Map<string, number> } {
  const byVoter = new Map<string, Record<string, number>>();
  for (const e of events) {
    if (e.type !== "workshop.votes") continue;
    const v = e.payload as { voter: string; allocation: Record<string, number> };
    byVoter.set(v.voter, v.allocation);
  }
  const byIdea = new Map<string, number>();
  for (const alloc of byVoter.values())
    for (const [ideaId, w] of Object.entries(alloc)) byIdea.set(ideaId, (byIdea.get(ideaId) ?? 0) + w);
  return { byVoter, byIdea };
}

export interface IdeaView {
  id: string;
  author: string;
  authorHandle: string;
  kind: string;
  title: string;
  pitch: string;
  incentive: string;
  createdAt: string;
  votes: number;
  built: BuildView | null;
}

export function deriveIdeas(events: readonly RoomEvent[], config: WorkshopConfig): IdeaView[] {
  const players = derivePlayers(events, config);
  const { byIdea } = deriveVotes(events);
  const builds = deriveBuilds(events);
  const out: IdeaView[] = [];
  for (const e of events) {
    if (e.type !== "workshop.idea") continue;
    const i = e.payload as { id: string; author: string; kind: string; title: string; pitch: string; incentive: string; createdAt: string };
    out.push({
      ...i,
      authorHandle: players.get(i.author)?.handle ?? i.author,
      votes: byIdea.get(i.id) ?? 0,
      built: builds.get(i.id) ?? null,
    });
  }
  return out;
}

export interface ScoreEntry {
  xId: string;
  handle: string;
  points: number;
  breakdown: { ideas: number; votes: number; builds: number; uptime: number };
  newAccount: boolean;
}

export function deriveNodeUptime(events: readonly RoomEvent[], nodeId: string): { upMinutes: number; upHours: number; lastHeartbeat: string | null } {
  // A node is up for a minute when a heartbeat lands in that minute's bucket.
  const buckets = new Set<number>();
  let last: string | null = null;
  for (const e of events) {
    if (e.type !== "workshop.heartbeat" || (e.payload as any).nodeId !== nodeId) continue;
    const at = (e.payload as any).at as string;
    buckets.add(Math.floor(Date.parse(at) / 60_000));
    if (!last || at > last) last = at;
  }
  return { upMinutes: buckets.size, upHours: Math.floor(buckets.size / 60), lastHeartbeat: last };
}

/** First-binding-only attribution: player x id -> node id (or "coordinator"). */
export function deriveAttribution(events: readonly RoomEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "player.attributed") continue;
    const a = e.payload as { player: string; nodeId: string };
    if (!out.has(a.player)) out.set(a.player, a.nodeId);
  }
  return out;
}

/** Bodies bound to a node, including the operator (for admission caps). */
export function countAttributionsTo(events: readonly RoomEvent[], nodeId: string): number {
  let n = 0;
  for (const [, bound] of deriveAttribution(events)) if (bound === nodeId) n++;
  return n;
}

export interface WorkshareView {
  url: string;
  player: string;
  handle: string;
  tweetId: string;
  tweetedAt: string;
  day: string; // ET day of the tweet
  counted: boolean; // as recorded (cap applied at record time)
  voided: boolean;
  voidReason: string | null;
  spent: boolean; // consumed by a generation request
  weight: number; // 1 when counted, unvoided and unspent, else 0
}

export function deriveWorkshares(events: readonly RoomEvent[]): WorkshareView[] {
  const voids = new Map<string, string>();
  const spent = new Set<string>();
  for (const e of events) {
    if (e.type === "workshare.voided") {
      const v = e.payload as { url: string; reason: string };
      if (!voids.has(v.url)) voids.set(v.url, v.reason);
    } else if (e.type === "generation.requested") {
      for (const u of ((e.payload as any).spentUrls as string[])) spent.add(u);
    }
  }
  const out: WorkshareView[] = [];
  for (const e of events) {
    if (e.type !== "workshare.recorded") continue;
    const w = e.payload as { url: string; player: string; handle: string; tweetId: string; tweetedAt: string; day: string; counted: boolean };
    if (out.some((x) => x.url === w.url)) continue; // first record wins; dupes never append
    const voided = voids.has(w.url);
    const isSpent = spent.has(w.url);
    out.push({ ...w, voided, voidReason: voids.get(w.url) ?? null, spent: isSpent, weight: w.counted && !voided && !isSpent ? 1 : 0 });
  }
  return out;
}

export interface NodeView {
  nodeId: string;
  operator: string;
  operatorHandle: string;
  url: string;
  publicKey: Record<string, unknown>;
  upMinutes: number;
  upHours: number;
  lastHeartbeat: string | null;
  up: boolean; // a heartbeat arrived within the window
  registeredAt: string;
  elapsedMinutes: number; // window minutes since registration (capped at close)
  uptimePct: number; // upMinutes / elapsedMinutes (0 when nothing elapsed)
  qualifies: boolean; // uptime at least 50%: earns operator weight
  attributedPlayers: number; // bound players, operator's own account excluded
  weight: number; // sqrt(attributedPlayers) when qualified, else 0 (producer node: fixed)
  capped: boolean; // the producer node admits a capped few and weighs a fixed 1
  leaseEnded: boolean;
  leaseReason: string | null;
}

export function deriveNodes(events: readonly RoomEvent[], config: WorkshopConfig, nowMs: number): NodeView[] {
  const players = derivePlayers(events, config);
  const attribution = deriveAttribution(events);
  const horizon = Math.min(nowMs, Date.parse(config.closesAt));
  const out: NodeView[] = [];
  for (const e of events) {
    if (e.type !== "workshop.node_registered") continue;
    const r = e.payload as { nodeId: string; operator: string; url: string; publicKey: Record<string, unknown> };
    if (out.some((n) => n.nodeId === r.nodeId)) continue;
    const { upMinutes, upHours, lastHeartbeat } = deriveNodeUptime(events, r.nodeId);
    const elapsedMinutes = Math.max(0, Math.floor((horizon - Date.parse(e.ts)) / 60_000));
    const uptimePct = elapsedMinutes === 0 ? 0 : upMinutes / elapsedMinutes;
    const qualifies = uptimePct >= 0.5;
    let attributedPlayers = 0;
    for (const [player, nodeId] of attribution) {
      if (nodeId === r.nodeId && player !== r.operator) attributedPlayers++; // never the operator's own account
    }
    const capped = r.nodeId === config.producerNode.nodeId;
    const lease = events.find((x) => x.type === "node.lease.ended" && (x.payload as any).nodeId === r.nodeId)?.payload as any;
    out.push({
      ...r,
      operatorHandle: players.get(r.operator)?.handle ?? r.operator,
      upMinutes,
      upHours,
      lastHeartbeat,
      up: lastHeartbeat !== null && nowMs - Date.parse(lastHeartbeat) <= config.heartbeatWindowSecs * 1000,
      registeredAt: e.ts,
      elapsedMinutes,
      uptimePct: Math.round(uptimePct * 10000) / 10000,
      qualifies,
      attributedPlayers,
      weight: capped ? (qualifies ? config.producerNode.operatorWeight : 0) : qualifies ? Math.sqrt(attributedPlayers) : 0,
      capped,
      leaseEnded: Boolean(lease),
      leaseReason: lease?.reason ?? null,
    });
  }
  return out;
}

/** Agnolo's score, derived. Sorted by points desc, then handle. */
export function deriveScoreboard(events: readonly RoomEvent[], config: WorkshopConfig): ScoreEntry[] {
  const players = derivePlayers(events, config);
  const { byIdea } = deriveVotes(events);
  const builds = deriveBuilds(events);
  const ideas = events.filter((e) => e.type === "workshop.idea").map((e) => e.payload as { id: string; author: string });
  const byAuthor = new Map<string, { ideas: number; votes: number; builds: number }>();
  const tally = (xId: string) => {
    let t = byAuthor.get(xId);
    if (!t) {
      t = { ideas: 0, votes: 0, builds: 0 };
      byAuthor.set(xId, t);
    }
    return t;
  };
  for (const i of ideas) {
    tally(i.author).ideas += 1;
    tally(i.author).votes += byIdea.get(i.id) ?? 0;
    if (builds.has(i.id)) tally(i.author).builds += 1;
  }
  const uptimeByOperator = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "workshop.node_registered") continue;
    const r = e.payload as { nodeId: string; operator: string };
    uptimeByOperator.set(r.operator, (uptimeByOperator.get(r.operator) ?? 0) + deriveNodeUptime(events, r.nodeId).upHours);
  }
  const entries: ScoreEntry[] = [];
  for (const [xId, p] of players) {
    const t = byAuthor.get(xId) ?? { ideas: 0, votes: 0, builds: 0 };
    const up = uptimeByOperator.get(xId) ?? 0;
    const breakdown = {
      ideas: t.ideas * config.points.idea,
      votes: t.votes * config.points.voteReceived,
      builds: t.builds * config.points.built,
      uptime: up * config.points.uptimeHour,
    };
    entries.push({ xId, handle: p.handle, points: breakdown.ideas + breakdown.votes + breakdown.builds + breakdown.uptime, breakdown, newAccount: p.newAccount });
  }
  entries.sort((a, b) => b.points - a.points || a.handle.localeCompare(b.handle));
  return entries;
}

export interface PlayerPayout {
  xId: string;
  handle: string;
  workshares: number; // counted, unvoided
  builds: number; // authored ideas Future Radio made
  weight: number; // workshares + blockBonus × builds (allow-listed: fixed)
  fixed: boolean; // allow-listed weight, independent of engagement
  n: number | null; // 1 for the producer row, so anyone can check the single share
  shareOfW: number; // pro rata by weight
  amount: number | null; // dollars; null until R and the operator share are set
}

export interface NodePayout {
  nodeId: string;
  operator: string;
  operatorHandle: string;
  attributedPlayers: number; // operator's own account excluded
  uptimePct: number;
  qualifies: boolean;
  weight: number; // sqrt(attributedPlayers) when qualified
  n: number; // attributed bodies (producer node: capped at maxPlayers)
  capped: boolean;
  shareOfO: number; // pro rata by weight
  amount: number | null; // dollars; null until R and the operator share are set
}

export interface StatusCtx {
  store: { all(): readonly RoomEvent[]; head: string };
  config: WorkshopConfig;
  now: () => number;
  mode: "coordinator" | "node";
  upstream?: string;
  nodeId?: string;
  verified?: () => boolean;
}

export interface StatusView {
  open: boolean;
  opensAt: string;
  closesAt: string;
  countdownMs: number;
  pledge: WorkshopConfig["pledge"];
  counts: { players: number; ideas: number; votePoints: number; builds: number; nodes: number };
  head: string;
  seq: number;
  mode: "coordinator" | "node";
  upstream?: string;
  nodeId?: string | null; // null when the node is not registered yet
  verified?: boolean;
}

/** Status: window, countdown, pledge, counts, chain head. Shared by HTTP + MCP. */
export function deriveStatus(ctx: StatusCtx): StatusView {
  const events = ctx.store.all();
  const { byVoter } = deriveVotes(events);
  let votePoints = 0;
  for (const alloc of byVoter.values()) for (const w of Object.values(alloc)) votePoints += w;
  const closesMs = Date.parse(ctx.config.closesAt);
  return {
    open: ctx.now() < closesMs,
    opensAt: ctx.config.opensAt,
    closesAt: ctx.config.closesAt,
    countdownMs: Math.max(0, closesMs - ctx.now()),
    pledge: ctx.config.pledge,
    counts: {
      players: events.filter((e) => e.type === "workshop.player").length,
      ideas: events.filter((e) => e.type === "workshop.idea").length,
      votePoints,
      builds: events.filter((e) => e.type === "workshop.build").length,
      nodes: events.filter((e) => e.type === "workshop.node_registered").length,
    },
    head: ctx.store.head,
    seq: events.length,
    mode: ctx.mode,
    ...(ctx.mode === "node" ? { upstream: ctx.upstream, nodeId: ctx.nodeId ?? null, verified: ctx.verified ? ctx.verified() : false } : {}),
  };
}

export interface RewardsView {
  status: "projected" | "final";
  prizeOutcome: "pending" | "won" | "lost";
  formula: string;
  inputs: { R: number | null; nextContest: number; operatorShare: number | null; blockBonus: number; closesAt: string };
  pools: { R: number; P: number; O: number; W: number; nextContest: number; operatorUnallocated: number } | null;
  pledge: WorkshopConfig["pledge"];
  operatorShareOfParticipants: number | null;
  operatorShareNote: string; // "not set" when null, never 0
  players: PlayerPayout[];
  nodes: NodePayout[];
  totals: { players: number; nodes: number; nextContest: number; unallocated: number; sum: number } | null;
}

export type ParsedSchedule = { kind: "now" } | { kind: "lump"; date: string } | { kind: "stream"; n: number; days: number };

export function parseSchedule(s: unknown): ParsedSchedule | null {
  if (s === "now") return { kind: "now" };
  if (typeof s !== "string") return null;
  const lump = s.match(/^lump_at:(.+)$/);
  if (lump) return Number.isFinite(Date.parse(lump[1])) ? { kind: "lump", date: new Date(lump[1]).toISOString() } : null;
  const stream = s.match(/^stream:(\d+)x(P1D|P7D|P30D)$/);
  if (stream) {
    const n = Number(stream[1]);
    if (!Number.isInteger(n) || n <= 0) return null;
    return { kind: "stream", n, days: stream[2] === "P1D" ? 1 : stream[2] === "P7D" ? 7 : 30 };
  }
  return null;
}

/** Split integer cents pro rata by weight (largest remainder: the sum is exact). */
function splitCents(totalCents: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (totalCents <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalCents * w) / total);
  const floors = raw.map(Math.floor);
  let left = totalCents - floors.reduce((s, c) => s + c, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i]++;
    left--;
  }
  return floors;
}

/**
 * v2 split (supersedes the v1 score-based projection). R comes from outside:
 * the prize if we win, the same amount as Story.markets debt if we don't.
 * P = R×(1−nextContest); O = P×operatorShare; W = P−O. Players earn W pro rata
 * by workshare weight; qualifying nodes earn O pro rata by sqrt weight. Money
 * is split in integer cents so the pools sum exactly to R.
 */
export function deriveRewards(events: readonly RoomEvent[], config: WorkshopConfig, nowMs: number): RewardsView {
  const R = config.rewardAmount;
  const nextContest = config.pledge.ifWin.nextContest;
  const share = config.pledge.nodeOperatorShareOfParticipants;
  const workshares = deriveWorkshares(events);
  const builds = deriveBuilds(events);
  const ideas = events.filter((e) => e.type === "workshop.idea").map((e) => e.payload as { id: string; author: string });
  const builtByAuthor = new Map<string, number>();
  for (const i of ideas) if (builds.has(i.id)) builtByAuthor.set(i.author, (builtByAuthor.get(i.author) ?? 0) + 1);
  const players = derivePlayers(events, config);
  const weighed = [...players.values()].map((p) => {
    const ws = workshares.filter((w) => w.player === p.xId).reduce((s, w) => s + w.weight, 0);
    const b = builtByAuthor.get(p.xId) ?? 0;
    const fixed = config.producerNode.allow.includes(p.xId);
    return {
      xId: p.xId,
      handle: p.handle,
      workshares: ws,
      builds: b,
      weight: fixed ? config.producerNode.fixedPlayerWeight : ws + config.blockBonus * b,
      fixed,
      n: fixed ? 1 : null,
    };
  });
  const wTotal = weighed.reduce((s, p) => s + p.weight, 0);
  const nodes = deriveNodes(events, config, nowMs);
  const oTotal = nodes.reduce((s, n) => s + n.weight, 0);

  const money = R !== null && share !== null;
  const rCents = money ? Math.round(R! * 100) : 0;
  const pCents = money ? Math.round(rCents * (1 - nextContest)) : 0;
  const oCents = money ? Math.round(pCents * share!) : 0;
  const playerCents = money ? splitCents(pCents - oCents, weighed.map((p) => p.weight)) : weighed.map(() => 0);
  const nodeCents = money ? splitCents(oCents, nodes.map((n) => n.weight)) : nodes.map(() => 0);
  const wCents = playerCents.reduce((s, c) => s + c, 0);
  const paidOCents = nodeCents.reduce((s, c) => s + c, 0);
  const nextCents = rCents - pCents; // the next contest is a fixed share, never a residual
  const unallocatedCents = pCents - wCents - paidOCents; // pool money with no earners yet

  return {
    status: config.pledge.prizeOutcome === "pending" ? "projected" : "final",
    prizeOutcome: config.pledge.prizeOutcome,
    formula: "P = R×(1−nextContest); O = P×operatorShare; W = P−O. Players earn W pro rata by weight = counted workshares + blockBonus×builds. Qualifying nodes (uptime ≥50%) earn O pro rata by weight = sqrt(attributed players, operator excluded). Cents split by largest remainder: pools sum exactly to R.",
    inputs: { R, nextContest, operatorShare: share, blockBonus: config.blockBonus, closesAt: config.closesAt },
    pools: money
      ? { R: rCents / 100, P: pCents / 100, O: oCents / 100, W: (pCents - oCents) / 100, nextContest: nextCents / 100, operatorUnallocated: (oCents - paidOCents) / 100 }
      : null,
    pledge: config.pledge,
    operatorShareOfParticipants: share,
    operatorShareNote: share === null ? "not set" : `${share * 100}% of the participants' share`,
    players: weighed.map((p, i) => ({
      ...p,
      shareOfW: wTotal === 0 ? 0 : Math.round((p.weight / wTotal) * 10000) / 10000,
      amount: money ? playerCents[i] / 100 : null,
    })),
    nodes: nodes.map((n, i) => ({
      nodeId: n.nodeId,
      operator: n.operator,
      operatorHandle: n.operatorHandle,
      attributedPlayers: n.attributedPlayers,
      uptimePct: n.uptimePct,
      qualifies: n.qualifies,
      weight: Math.round(n.weight * 10000) / 10000,
      n: n.capped ? Math.min(countAttributionsTo(events, n.nodeId), config.producerNode.maxPlayers) : n.attributedPlayers,
      capped: n.capped,
      shareOfO: oTotal === 0 ? 0 : Math.round((n.weight / oTotal) * 10000) / 10000,
      amount: money ? nodeCents[i] / 100 : null,
    })),
    totals: money
      ? {
          players: wCents / 100,
          nodes: paidOCents / 100,
          nextContest: nextCents / 100,
          unallocated: unallocatedCents / 100,
          sum: (wCents + paidOCents + nextCents + unallocatedCents) / 100,
        }
      : null,
  };
}

// ---------------------------------------------------------------- settlement (obligations only; never executes transfers)

export interface NodeProfile {
  qi: number;
  quai: number;
  fiat: number;
  schedule: string;
}

/** Latest payout profile per node (last payout.profile.set wins; registration is first). */
export function derivePayoutProfiles(events: readonly RoomEvent[]): Map<string, NodeProfile> {
  const out = new Map<string, NodeProfile>();
  for (const e of events) {
    if (e.type === "workshop.node_registered" && (e.payload as any).payout) out.set((e.payload as any).nodeId, (e.payload as any).payout);
    else if (e.type === "payout.profile.set") out.set((e.payload as any).nodeId, (e.payload as any).payout);
  }
  return out;
}

export interface ScheduledPayout {
  asset: "qi" | "quai" | "fiat";
  fraction: number;
  schedule: string;
  amounts: Array<{ date: string | null; amount: number | null }>; // date null = due now
}

export interface OperatorSettlement {
  operator: string;
  operatorHandle: string;
  total: number | null;
  nodes: Array<{
    nodeId: string;
    share: number | null;
    profile: NodeProfile | null;
    payouts: ScheduledPayout[];
  }>;
}

export interface SettlementView {
  status: "obligation" | "final"; // obligation until the prize outcome is known; never "paid"
  prizeOutcome: "pending" | "won" | "lost";
  R: number | null;
  closesAt: string;
  note: string;
  operators: OperatorSettlement[];
}

/** Render one asset total across a schedule, in exact cents. Streams start one interval after close. */
function renderSchedule(totalCents: number, schedule: ParsedSchedule, closesMs: number): Array<{ date: string | null; amount: number }> {
  if (schedule.kind === "now") return [{ date: null, amount: totalCents / 100 }];
  if (schedule.kind === "lump") return [{ date: schedule.date, amount: totalCents / 100 }];
  const parts = splitCents(totalCents, new Array(schedule.n).fill(1));
  return parts.map((c, k) => ({ date: new Date(closesMs + (k + 1) * schedule.days * 86_400_000).toISOString(), amount: c / 100 }));
}

/**
 * Settlement: per operator, the computed share, the payout profile, and the
 * schedule as dated amounts. Pure over the log, so any node reproduces it
 * exactly. Obligations only — nothing here moves money.
 */
export function deriveSettlement(events: readonly RoomEvent[], config: WorkshopConfig, nowMs: number): SettlementView {
  const rewards = deriveRewards(events, config, nowMs);
  const profiles = derivePayoutProfiles(events);
  const closesMs = Date.parse(config.closesAt);
  const byOperator = new Map<string, OperatorSettlement>();
  for (const n of rewards.nodes) {
    let op = byOperator.get(n.operator);
    if (!op) {
      op = { operator: n.operator, operatorHandle: n.operatorHandle, total: 0, nodes: [] };
      byOperator.set(n.operator, op);
    }
    const profile = profiles.get(n.nodeId) ?? null;
    const payouts: ScheduledPayout[] = [];
    if (profile && n.amount !== null) {
      const shareCents = Math.round(n.amount * 100);
      const assetCents = splitCents(shareCents, [profile.qi, profile.quai, profile.fiat]);
      const sched = parseSchedule(profile.schedule) ?? { kind: "now" as const };
      (["qi", "quai", "fiat"] as const).forEach((asset, i) => {
        payouts.push({ asset, fraction: profile[asset], schedule: profile.schedule, amounts: renderSchedule(assetCents[i], sched, closesMs) });
      });
      op.total = (op.total ?? 0) + n.amount;
    } else if (n.amount !== null) {
      op.total = (op.total ?? 0) + n.amount;
    } else {
      op.total = null;
    }
    op.nodes.push({ nodeId: n.nodeId, share: n.amount, profile, payouts });
  }
  for (const op of byOperator.values()) {
    if (op.total !== null) op.total = Math.round(op.total * 100) / 100;
    op.nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  }
  return {
    status: config.pledge.prizeOutcome === "pending" ? "obligation" : "final",
    prizeOutcome: config.pledge.prizeOutcome,
    R: config.rewardAmount,
    closesAt: config.closesAt,
    note: "Obligations only. Nothing here executes transfers.",
    operators: [...byOperator.values()].sort((a, b) => a.operatorHandle.localeCompare(b.operatorHandle)),
  };
}
