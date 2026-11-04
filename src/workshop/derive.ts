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
}

export function deriveNodes(events: readonly RoomEvent[], config: WorkshopConfig, nowMs: number): NodeView[] {
  const players = derivePlayers(events, config);
  const out: NodeView[] = [];
  for (const e of events) {
    if (e.type !== "workshop.node_registered") continue;
    const r = e.payload as { nodeId: string; operator: string; url: string; publicKey: Record<string, unknown> };
    if (out.some((n) => n.nodeId === r.nodeId)) continue;
    const { upMinutes, upHours, lastHeartbeat } = deriveNodeUptime(events, r.nodeId);
    out.push({
      ...r,
      operatorHandle: players.get(r.operator)?.handle ?? r.operator,
      upMinutes,
      upHours,
      lastHeartbeat,
      up: lastHeartbeat !== null && nowMs - Date.parse(lastHeartbeat) <= config.heartbeatWindowSecs * 1000,
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

export interface RewardSplit {
  xId: string;
  handle: string;
  points: number;
  shareOfParticipants: number; // pro rata by points (0 when nobody scored)
  operatorShare: number | null; // pro rata by uptime points, from the operator pool; null when share not set
}

export interface RewardsView {
  status: "projected" | "final";
  prizeOutcome: "pending" | "won" | "lost";
  pledge: WorkshopConfig["pledge"];
  operatorShareOfParticipants: number | null;
  operatorShareNote: string; // "not set" when null, never 0
  operatorPool: number | null; // fraction of the prize reserved for operators
  splits: RewardSplit[];
}

/**
 * Projected split from the scores: participants pro rata by points, operators
 * paid from their share pro rata by uptime. Projected until won/lost.
 */
export function deriveRewards(events: readonly RoomEvent[], config: WorkshopConfig): RewardsView {
  const board = deriveScoreboard(events, config);
  const total = board.reduce((s, r) => s + r.points, 0);
  const totalUptime = board.reduce((s, r) => s + r.breakdown.uptime, 0);
  const share = config.pledge.nodeOperatorShareOfParticipants;
  const participantsPool = config.pledge.ifWin.participants;
  return {
    status: config.pledge.prizeOutcome === "pending" ? "projected" : "final",
    prizeOutcome: config.pledge.prizeOutcome,
    pledge: config.pledge,
    operatorShareOfParticipants: share,
    operatorShareNote: share === null ? "not set" : `${share * 100}% of the participants' share`,
    operatorPool: share === null ? null : Math.round(participantsPool * share * 10000) / 10000,
    splits: board.map((r) => ({
      xId: r.xId,
      handle: r.handle,
      points: r.points,
      shareOfParticipants: total === 0 ? 0 : Math.round((r.points / total) * 10000) / 10000,
      operatorShare: share === null ? null : totalUptime === 0 ? 0 : Math.round((r.breakdown.uptime / totalUptime) * participantsPool * share * 10000) / 10000,
    })),
  };
}
