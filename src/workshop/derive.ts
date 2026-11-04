// Derivation: scoreboard, rewards and node uptime computed from the log, never
// stored. Every function here is pure over (events, config, now).

import type { RoomEvent } from "../core/types.ts";
import { sha256, canonical } from "../core/events.ts";
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

export interface AuditView {
  nodeId: string;
  result: "pass" | "fail";
  k: number | null;
  via: "coordinator" | "peer";
  reporterNode: string | null;
  at: string;
}

/** Audit history for one node (or all), oldest first. */
export function deriveAudits(events: readonly RoomEvent[], nodeId?: string): AuditView[] {
  const out: AuditView[] = [];
  for (const e of events) {
    if (e.type !== "node.audit") continue;
    const a = e.payload as { nodeId: string; result: "pass" | "fail"; k: number | null; via: "coordinator" | "peer"; reporterNode?: string; at: string };
    if (nodeId && a.nodeId !== nodeId) continue;
    out.push({ nodeId: a.nodeId, result: a.result, k: a.k ?? null, via: a.via, reporterNode: a.reporterNode ?? null, at: a.at });
  }
  out.sort((x, y) => x.at.localeCompare(y.at));
  return out;
}

/** Three straight failures with no pass since suspend the node's operator credit. */
export function nodeSuspended(events: readonly RoomEvent[], nodeId: string): boolean {
  const audits = deriveAudits(events, nodeId);
  if (audits.length < 3) return false;
  return audits.slice(-3).every((a) => a.result === "fail");
}

export function deriveNodeUptime(events: readonly RoomEvent[], nodeId: string): { upMinutes: number; upHours: number; lastHeartbeat: string | null } {
  // A node is up for a minute when a heartbeat lands in that minute's bucket —
  // but uptime only counts while audits pass. A heartbeat counts when the
  // latest audit at its time is a pass, or no audit has run yet.
  const audits = deriveAudits(events, nodeId);
  const buckets = new Set<number>();
  let last: string | null = null;
  for (const e of events) {
    if (e.type !== "workshop.heartbeat" || (e.payload as any).nodeId !== nodeId) continue;
    const at = (e.payload as any).at as string;
    const latest = audits.filter((a) => a.at <= at).at(-1);
    if (latest && latest.result === "fail") continue;
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
  weight: number; // sqrt(attributedPlayers) when authorized, qualified, unsuspended and unquarantined, else 0 (producer node: fixed)
  capped: boolean; // the producer node admits a capped few and weighs a fixed 1
  leaseEnded: boolean;
  leaseReason: string | null;
  authorized: boolean; // the operator posted the fingerprint and oEmbed confirmed it
  authorizedBy: string | null; // the thread reply URL
  suspended: boolean; // three straight audit failures, no pass since
  revoked: boolean;
  revokeReason: string | null;
  quarantined: boolean; // an open or upheld flag holds this node's weight
}

/** nodeId -> authorization reply URL (first node.authorized wins). */
export function deriveAuthorized(events: readonly RoomEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "node.authorized") continue;
    const a = e.payload as { nodeId: string; url: string };
    if (!out.has(a.nodeId)) out.set(a.nodeId, a.url);
  }
  return out;
}

/** nodeId -> revocation (first node.revoked wins; revocation is permanent). */
export function deriveRevoked(events: readonly RoomEvent[]): Map<string, { reason: string; at: string }> {
  const out = new Map<string, { reason: string; at: string }>();
  for (const e of events) {
    if (e.type !== "node.revoked") continue;
    const r = e.payload as { nodeId: string; reason: string; at: string };
    if (!out.has(r.nodeId)) out.set(r.nodeId, { reason: r.reason, at: r.at });
  }
  return out;
}

/** Does this X account operate an authorized, unrevoked node? */
export function operatesAuthorizedNode(events: readonly RoomEvent[], xId: string): boolean {
  const auth = deriveAuthorized(events);
  const revoked = deriveRevoked(events);
  return events.some(
    (e) => e.type === "workshop.node_registered" && (e.payload as any).operator === xId && auth.has((e.payload as any).nodeId) && !revoked.has((e.payload as any).nodeId),
  );
}

export function deriveNodes(events: readonly RoomEvent[], config: WorkshopConfig, nowMs: number): NodeView[] {
  const players = derivePlayers(events, config);
  const attribution = deriveAttribution(events);
  const authorized = deriveAuthorized(events);
  const revoked = deriveRevoked(events);
  const quarantined = quarantinedSubjects(events).nodes;
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
    const isAuthorized = authorized.has(r.nodeId);
    const isRevoked = revoked.has(r.nodeId);
    const suspended = nodeSuspended(events, r.nodeId);
    const held = quarantined.has(r.nodeId);
    const earns = isAuthorized && !isRevoked && !suspended && !held;
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
      weight: !earns ? 0 : capped ? (qualifies ? config.producerNode.operatorWeight : 0) : qualifies ? Math.sqrt(attributedPlayers) : 0,
      capped,
      leaseEnded: Boolean(lease),
      leaseReason: lease?.reason ?? null,
      authorized: isAuthorized,
      authorizedBy: authorized.get(r.nodeId) ?? null,
      suspended,
      revoked: isRevoked,
      revokeReason: revoked.get(r.nodeId)?.reason ?? null,
      quarantined: held,
    });
  }
  return out;
}

export interface FlagView {
  id: string;
  subjectHash: string; // pseudonymous until appealed or resolved
  subjectKind: "player" | "node";
  signal: string;
  evidence: unknown;
  reporterHash: string | null;
  status: "open" | "appealed" | "upheld" | "cleared";
  subject?: string; // revealed once appealed or resolved
  reporter?: string | null;
  appealedAt: string | null;
  resolvedAt: string | null;
  note: string | null;
}

/** Flags with their lifecycle. Subjects stay pseudonymous until they have had the chance to appeal. */
export function deriveFlags(events: readonly RoomEvent[]): FlagView[] {
  const appealed = new Map<string, string>();
  const resolved = new Map<string, { decision: string; note: string; at: string }>();
  for (const e of events) {
    if (e.type === "flag.appealed") {
      const a = e.payload as { id: string; at: string };
      if (!appealed.has(a.id)) appealed.set(a.id, a.at);
    } else if (e.type === "flag.resolved") {
      const r = e.payload as { id: string; decision: string; note: string; at: string };
      if (!resolved.has(r.id)) resolved.set(r.id, { decision: r.decision, note: r.note, at: r.at });
    }
  }
  const out: FlagView[] = [];
  for (const e of events) {
    if (e.type !== "flag.raised") continue;
    const f = e.payload as { id: string; subject: string; subjectKind: "player" | "node"; signal: string; evidence: unknown; reporter: string | null };
    if (out.some((x) => x.id === f.id)) continue;
    const r = resolved.get(f.id);
    const status = r ? ((r.decision as "upheld" | "cleared")) : appealed.has(f.id) ? "appealed" : "open";
    const revealed = status !== "open";
    out.push({
      id: f.id,
      subjectHash: sha256(f.subject).slice(0, 16),
      subjectKind: f.subjectKind,
      signal: f.signal,
      evidence: f.evidence,
      reporterHash: f.reporter ? sha256(f.reporter).slice(0, 16) : null,
      status,
      ...(revealed ? { subject: f.subject, reporter: f.reporter } : {}),
      appealedAt: appealed.get(f.id) ?? null,
      resolvedAt: r?.at ?? null,
      note: r?.note ?? null,
    });
  }
  return out;
}

/** Subjects whose weight is held: flagged and not cleared. */
export function quarantinedSubjects(events: readonly RoomEvent[]): { players: Set<string>; nodes: Set<string> } {
  const players = new Set<string>();
  const nodes = new Set<string>();
  const cleared = new Set<string>();
  for (const e of events) {
    if (e.type === "flag.resolved" && (e.payload as any).decision === "cleared") cleared.add((e.payload as any).id as string);
  }
  for (const e of events) {
    if (e.type !== "flag.raised") continue;
    const f = e.payload as { id: string; subject: string; subjectKind: string };
    if (cleared.has(f.id)) continue;
    if (f.subjectKind === "player") players.add(f.subject);
    else if (f.subjectKind === "node") nodes.add(f.subject);
  }
  return { players, nodes };
}

export interface ChallengeView {
  id: string;
  claim: string;
  evidence: string;
  by: string;
  handle: string;
  at: string;
  status: "open" | "accepted" | "rejected";
  resolvedAt: string | null;
  note: string | null;
}

export function deriveChallenges(events: readonly RoomEvent[]): ChallengeView[] {
  const resolved = new Map<string, { decision: string; note: string; at: string }>();
  for (const e of events) {
    if (e.type !== "challenge.resolved") {
      const r = e.payload as { id: string; decision: string; note: string; at: string };
      if (!resolved.has(r.id)) resolved.set(r.id, { decision: r.decision, note: r.note, at: r.at });
    }
  }
  const out: ChallengeView[] = [];
  for (const e of events) {
    if (e.type !== "challenge.filed") continue;
    const c = e.payload as { id: string; claim: string; evidence: string; by: string; handle: string; at: string };
    if (out.some((x) => x.id === c.id)) continue;
    const r = resolved.get(c.id);
    out.push({ ...c, status: r ? (r.decision as "accepted" | "rejected") : "open", resolvedAt: r?.at ?? null, note: r?.note ?? null });
  }
  return out;
}

export interface BountyClaim {
  reporter: string; // x id
  kind: "peer_audit" | "challenge" | "abuse" | "pretender";
  dollars: number;
  ref: string; // the audit / challenge / flag / pretender entry behind it
}

/**
 * Validator bounty claims on the reserve, oldest first: confirmed peer audits
 * (logged fail via a peer report), accepted challenges, upheld abuse reports
 * with a reporter, and confirmed pretender reports. Amounts come from config.
 */
export function deriveBountyClaims(events: readonly RoomEvent[], config: WorkshopConfig): BountyClaim[] {
  const out: BountyClaim[] = [];
  const operatorOf = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "workshop.node_registered") continue;
    const r = e.payload as { nodeId: string; operator: string };
    if (!operatorOf.has(r.nodeId)) operatorOf.set(r.nodeId, r.operator);
  }
  const raised = new Map<string, { reporter: string | null; signal: string }>();
  for (const e of events) {
    if (e.type === "flag.raised") {
      const f = e.payload as { id: string; reporter: string | null; signal: string };
      if (!raised.has(f.id)) raised.set(f.id, { reporter: f.reporter, signal: f.signal });
    }
  }
  const challengerOf = new Map<string, string>();
  for (const e of events) {
    if (e.type === "challenge.filed") {
      const c = e.payload as { id: string; by: string };
      if (!challengerOf.has(c.id)) challengerOf.set(c.id, c.by);
    }
  }
  for (const e of events) {
    if (e.type === "node.audit") {
      const a = e.payload as { result: string; via: string; reporterNode?: string };
      if (a.result === "fail" && a.via === "peer" && a.reporterNode && operatorOf.has(a.reporterNode))
        out.push({ reporter: operatorOf.get(a.reporterNode)!, kind: "peer_audit", dollars: config.auditBountyPoints, ref: `${a.reporterNode}→${(e.payload as any).nodeId}@${(e.payload as any).at}` });
    } else if (e.type === "challenge.resolved") {
      const r = e.payload as { id: string; decision: string };
      if (r.decision === "accepted" && challengerOf.has(r.id))
        out.push({ reporter: challengerOf.get(r.id)!, kind: "challenge", dollars: config.challengeBountyPoints, ref: r.id });
    } else if (e.type === "flag.resolved") {
      const r = e.payload as { id: string; decision: string };
      const f = raised.get(r.id);
      if (r.decision === "upheld" && f?.reporter && f.signal !== "pretender_claim")
        out.push({ reporter: f.reporter, kind: "abuse", dollars: config.abuseBountyPoints, ref: r.id });
    } else if (e.type === "pretender.confirmed") {
      const p = e.payload as { reporter: string; url: string };
      out.push({ reporter: p.reporter, kind: "pretender", dollars: config.pretenderBountyPoints, ref: p.url });
    }
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
  weight: number; // workshares + blockBonus × builds (allow-listed: fixed); 0 while quarantined
  fixed: boolean; // allow-listed weight, independent of engagement
  n: number | null; // 1 for the producer row, so anyone can check the single share
  quarantined: boolean; // an open or upheld flag holds this player's weight
  shareOfW: number; // pro rata by weight
  amount: number | null; // dollars; null until R and the operator share are set
  bounty: number | null; // validator bounty dollars from the reserve (null until R is set)
}

export interface NodePayout {
  nodeId: string;
  operator: string;
  operatorHandle: string;
  attributedPlayers: number; // operator's own account excluded
  uptimePct: number;
  qualifies: boolean;
  weight: number; // sqrt(attributedPlayers) when authorized, qualified, unsuspended and unquarantined
  n: number; // attributed bodies (producer node: capped at maxPlayers)
  capped: boolean;
  authorized: boolean;
  suspended: boolean;
  quarantined: boolean;
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
  pools: { R: number; P: number; O: number; W: number; V: number; nextContest: number; operatorUnallocated: number; reserveUnused: number } | null;
  pledge: WorkshopConfig["pledge"];
  operatorShareOfParticipants: number | null;
  operatorShareNote: string; // "not set" when null, never 0
  players: PlayerPayout[];
  nodes: NodePayout[];
  quarantine: { playerWeight: number; nodeWeight: number }; // weight held by open or upheld flags
  totals: { players: number; nodes: number; bounties: number; nextContest: number; unallocated: number; sum: number } | null;
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
 * v2 split with the v5 validation reserve (supersedes the v1 score-based
 * projection). R comes from outside: the prize if we win, the same amount as
 * Story.markets debt if we don't. P = R×(1−nextContest); O = P×operatorShare;
 * V = P×validationReserve; W = P−O−V. Players earn W pro rata by workshare
 * weight; authorized, qualifying, unsuspended nodes earn O pro rata by sqrt
 * weight. Validator bounties come from V (pro rata when over-subscribed);
 * unused V returns to the players. Quarantined weight earns nothing: it is
 * forfeited to the honest players pro rata, plus the reporter's bounty. Money
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
  const held = quarantinedSubjects(events);
  const weighed = [...players.values()].map((p) => {
    const ws = workshares.filter((w) => w.player === p.xId).reduce((s, w) => s + w.weight, 0);
    const b = builtByAuthor.get(p.xId) ?? 0;
    const fixed = config.producerNode.allow.includes(p.xId);
    const full = fixed ? config.producerNode.fixedPlayerWeight : ws + config.blockBonus * b;
    const quarantined = held.players.has(p.xId);
    return {
      xId: p.xId,
      handle: p.handle,
      workshares: ws,
      builds: b,
      full,
      weight: quarantined ? 0 : full,
      fixed,
      n: fixed ? 1 : null,
      quarantined,
    };
  });
  const wTotal = weighed.reduce((s, p) => s + p.weight, 0);
  const nodes = deriveNodes(events, config, nowMs);
  const oTotal = nodes.reduce((s, n) => s + n.weight, 0);
  const heldPlayerWeight = weighed.filter((p) => p.quarantined).reduce((s, p) => s + p.full, 0);
  const heldNodeWeight = nodes.filter((n) => n.quarantined).reduce((s, n) => s + (n.authorized && !n.revoked && !n.suspended && n.qualifies ? (n.capped ? config.producerNode.operatorWeight : Math.sqrt(n.attributedPlayers)) : 0), 0);

  const money = R !== null && share !== null;
  const rCents = money ? Math.round(R! * 100) : 0;
  const pCents = money ? Math.round(rCents * (1 - nextContest)) : 0;
  const oCents = money ? Math.round(pCents * share!) : 0;
  const vCents = money ? Math.round(pCents * config.validationReserve) : 0;
  const claims = money ? deriveBountyClaims(events, config) : [];
  const claimCents = claims.map((c) => Math.round(c.dollars * 100));
  const paidClaimCents = money && vCents > 0 ? splitCents(vCents, claimCents) : claimCents.map(() => 0);
  const paidVCents = paidClaimCents.reduce((s, c) => s + c, 0);
  const unusedVCents = vCents - paidVCents; // unused reserve returns to the players
  const wSplitCents = pCents - oCents - vCents + unusedVCents;
  const playerCents = money ? splitCents(wSplitCents, weighed.map((p) => p.weight)) : weighed.map(() => 0);
  const nodeCents = money ? splitCents(oCents, nodes.map((n) => n.weight)) : nodes.map(() => 0);
  const wCents = playerCents.reduce((s, c) => s + c, 0);
  const paidOCents = nodeCents.reduce((s, c) => s + c, 0);
  const nextCents = rCents - pCents; // the next contest is a fixed share, never a residual
  const unallocatedCents = wSplitCents - wCents + (oCents - paidOCents); // pool money with no earners yet
  const bountyByReporter = new Map<string, number>();
  claims.forEach((c, i) => bountyByReporter.set(c.reporter, (bountyByReporter.get(c.reporter) ?? 0) + paidClaimCents[i]));
  // Bounty-only recipients (defensive: every reporter is a player, but the log is the log).
  const extras = [...bountyByReporter.keys()]
    .filter((xId) => !weighed.some((p) => p.xId === xId))
    .map((xId) => ({ xId, handle: xId, workshares: 0, builds: 0, full: 0, weight: 0, fixed: false, n: null, quarantined: false }));

  return {
    status: config.pledge.prizeOutcome === "pending" ? "projected" : "final",
    prizeOutcome: config.pledge.prizeOutcome,
    formula:
      "P = R×(1−nextContest); O = P×operatorShare; V = P×validationReserve; W = P−O−V. Players earn W pro rata by weight = counted workshares + blockBonus×builds. Authorized, qualifying (uptime ≥50%), unsuspended nodes earn O pro rata by weight = sqrt(attributed players, operator excluded). Validator bounties (peer audits, accepted challenges, upheld abuse reports, confirmed pretenders) come from V, pro rata when over-subscribed; unused V returns to the players. Quarantined weight earns nothing and is forfeited to honest players pro rata at finalization. Cents split by largest remainder: pools sum exactly to R.",
    inputs: { R, nextContest, operatorShare: share, blockBonus: config.blockBonus, closesAt: config.closesAt },
    pools: money
      ? {
          R: rCents / 100,
          P: pCents / 100,
          O: oCents / 100,
          W: (pCents - oCents - vCents) / 100,
          V: vCents / 100,
          nextContest: nextCents / 100,
          operatorUnallocated: (oCents - paidOCents) / 100,
          reserveUnused: unusedVCents / 100,
        }
      : null,
    pledge: config.pledge,
    operatorShareOfParticipants: share,
    operatorShareNote: share === null ? "not set" : `${share * 100}% of the participants' share`,
    players: [...weighed, ...extras].map((p, i) => ({
      xId: p.xId,
      handle: p.handle,
      workshares: p.workshares,
      builds: p.builds,
      weight: p.weight,
      fixed: p.fixed,
      n: p.n,
      quarantined: p.quarantined,
      shareOfW: wTotal === 0 ? 0 : Math.round((p.weight / wTotal) * 10000) / 10000,
      amount: money ? (i < playerCents.length ? playerCents[i] / 100 : 0) : null,
      bounty: money ? (bountyByReporter.get(p.xId) ?? 0) / 100 : null,
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
      authorized: n.authorized,
      suspended: n.suspended,
      quarantined: n.quarantined,
      shareOfO: oTotal === 0 ? 0 : Math.round((n.weight / oTotal) * 10000) / 10000,
      amount: money ? nodeCents[i] / 100 : null,
    })),
    quarantine: { playerWeight: heldPlayerWeight, nodeWeight: heldNodeWeight },
    totals: money
      ? {
          players: wCents / 100,
          nodes: paidOCents / 100,
          bounties: paidVCents / 100,
          nextContest: nextCents / 100,
          unallocated: unallocatedCents / 100,
          sum: (wCents + paidOCents + paidVCents + nextCents + unallocatedCents) / 100,
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

export interface SettlementSnapshot {
  formula: string;
  inputs: {
    R: number | null;
    nextContest: number;
    operatorShare: number | null;
    validationReserve: number;
    blockBonus: number;
    closesAt: string;
    prizeOutcome: "pending" | "won" | "lost";
    players: Array<{ xId: string; weight: number; quarantined: boolean; bounty: number | null }>;
    nodes: Array<{ nodeId: string; weight: number; quarantined: boolean }>;
    claims: BountyClaim[];
  };
  operators: OperatorSettlement[];
  hash: string;
}

/** The proposed settlement: formula, every input, amounts owed, and their hash. Anyone re-derives it from the log and compares hashes. */
export function settlementSnapshot(events: readonly RoomEvent[], config: WorkshopConfig, nowMs: number): SettlementSnapshot {
  const rewards = deriveRewards(events, config, nowMs);
  const settlement = deriveSettlement(events, config, nowMs);
  const formula = rewards.formula;
  const inputs: SettlementSnapshot["inputs"] = {
    R: config.rewardAmount,
    nextContest: config.pledge.ifWin.nextContest,
    operatorShare: config.pledge.nodeOperatorShareOfParticipants,
    validationReserve: config.validationReserve,
    blockBonus: config.blockBonus,
    closesAt: config.closesAt,
    prizeOutcome: config.pledge.prizeOutcome,
    players: rewards.players.map((p) => ({ xId: p.xId, weight: p.weight, quarantined: p.quarantined, bounty: p.bounty })),
    nodes: rewards.nodes.map((n) => ({ nodeId: n.nodeId, weight: n.weight, quarantined: n.quarantined })),
    claims: deriveBountyClaims(events, config),
  };
  const hash = sha256(canonical({ formula, inputs, operators: settlement.operators }));
  return { formula, inputs, operators: settlement.operators, hash };
}

export interface SettlementPhase {
  phase: "open" | "proposed" | "challenged" | "final";
  closed: boolean;
  proposal: { hash: string; at: string; windowEndsAt: string } | null;
  finalized: { hash: string; at: string } | null;
  openChallenges: string[];
  settlement: SettlementView;
}

/** Settlement with its lifecycle: proposed at close, challenged in the window, final when the window ends with all resolved. */
export function deriveSettlementPhase(events: readonly RoomEvent[], config: WorkshopConfig, nowMs: number): SettlementPhase {
  const proposals = events.filter((e) => e.type === "settlement.proposed");
  const latest = proposals.at(-1)?.payload as { hash: string; at: string } | undefined;
  const fin = events.find((e) => e.type === "settlement.finalized")?.payload as { hash: string; at: string } | undefined;
  const resolved = new Set(events.filter((e) => e.type === "challenge.resolved").map((e) => (e.payload as any).id as string));
  const open = events
    .filter((e) => e.type === "challenge.filed" && !resolved.has((e.payload as any).id as string))
    .map((e) => (e.payload as any).id as string);
  const closed = nowMs >= Date.parse(config.closesAt);
  return {
    phase: fin ? "final" : !latest ? "open" : open.length ? "challenged" : "proposed",
    closed,
    proposal: latest ? { hash: latest.hash, at: latest.at, windowEndsAt: new Date(Date.parse(latest.at) + config.challengeWindowDays * 86_400_000).toISOString() } : null,
    finalized: fin ? { hash: fin.hash, at: fin.at } : null,
    openChallenges: open,
    settlement: deriveSettlement(events, config, nowMs),
  };
}
