// The workshop log: a hash-chained event store (the room's EventStore) kept in a
// separate file from the writers' room log. All writes flow through here so
// close enforcement, budgets and identity rules hold in code, not in prompts.

import { createPublicKey, verify } from "node:crypto";
import { join } from "node:path";
import { EventStore, sha256, canonical } from "../core/events.ts";
import type { RoomEvent } from "../core/types.ts";
import type { WorkshopConfig } from "./config.ts";
import { countAttributionsTo, deriveFlags, deriveScoreboard, parseSchedule, settlementSnapshot } from "./derive.ts";

export class WorkshopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type WorkshopMode = "coordinator" | "node";

export interface WorkshopCtx {
  store: EventStore;
  config: WorkshopConfig;
  now: () => number; // ms epoch; injected so tests freeze time
  mode: WorkshopMode;
  upstream?: string; // node mode: coordinator base URL
  nodeId?: string; // node mode: this replica's registered id (for ?via= links)
  producerToken: string;
  verified?: () => boolean; // node mode: serve gate (false = refuse everything)
  fetchImpl?: typeof fetch; // outbound HTTP (oEmbed, X); injected in tests
  registrySign?: (msg: Buffer) => Buffer; // coordinator: signs the referee registry (private key never leaves the process)
  nodeSign?: (msg: Buffer) => Buffer; // node: answers audit challenges with the node key
  registryCache?: { entries: unknown[]; seq: number; signature: string } | null; // node: mirrored signed registry
}

export const WORKSHOP_LOG_PATH = () => join(process.env.DATA_DIR ?? join(process.cwd(), "data"), "workshop", "events.jsonl");

export function openWorkshop(path = WORKSHOP_LOG_PATH()): EventStore {
  return new EventStore(path);
}

/** Append workshop.opened on first start so the window is on the record. */
export function ensureOpened(ctx: WorkshopCtx): void {
  if (ctx.mode !== "coordinator") return;
  if (ctx.store.all().some((e) => e.type === "workshop.opened")) return;
  ctx.store.append("workshop.opened", "system", { opensAt: ctx.config.opensAt, closesAt: ctx.config.closesAt }, "public", new Date(ctx.now()).toISOString());
}

export const isClosed = (config: WorkshopConfig, nowMs: number): boolean => nowMs >= Date.parse(config.closesAt);

/** Close is enforced in code: after closesAt every write throws 409. */
export function assertOpen(ctx: WorkshopCtx): void {
  if (isClosed(ctx.config, ctx.now())) throw new WorkshopError("workshop_closed", `The workshop closed at ${ctx.config.closesAt}.`, 409);
}

export function assertCoordinator(ctx: WorkshopCtx): void {
  if (ctx.mode !== "coordinator") throw new WorkshopError("node_readonly", "This node is read-only. Writes go to the coordinator.", 403);
}

function assertVerified(ctx: WorkshopCtx): void {
  if (ctx.mode === "node" && ctx.verified && !ctx.verified())
    throw new WorkshopError("chain_unverified", "This node refuses to serve: the upstream chain does not verify.", 503);
}

/** Every read passes through here in node mode; the gate refuses on a broken chain. */
export function assertServing(ctx: WorkshopCtx): void {
  assertVerified(ctx);
}

/**
 * At close the coordinator appends one workshop.closed event with the final
 * scoreboard snapshot and its hash. Called on every request; appends once.
 */
export function maybeClose(ctx: WorkshopCtx): RoomEvent | null {
  if (ctx.mode !== "coordinator") return null;
  if (!isClosed(ctx.config, ctx.now())) return null;
  if (ctx.store.all().some((e) => e.type === "workshop.closed")) return null;
  const scoreboard = deriveScoreboard(ctx.store.all(), ctx.config);
  return ctx.store.append(
    "workshop.closed",
    "system",
    { at: new Date(ctx.now()).toISOString(), scoreboard, hash: sha256(canonical(scoreboard)) },
    "public",
    new Date(ctx.now()).toISOString(),
  );
}

// ---------------------------------------------------------------- writes

export function hasPlayer(store: EventStore, xId: string): boolean {
  return store.all().some((e) => e.type === "workshop.player" && (e.payload as any).xId === xId);
}

/** One player per X user id. Re-sign-ins reuse the record (the caller catches). */
export function addPlayer(ctx: WorkshopCtx, p: { xId: string; handle: string; createdAt: string }): RoomEvent {
  assertCoordinator(ctx);
  assertOpen(ctx);
  if (!p.xId || !p.handle) throw new WorkshopError("bad_player", "X user id and handle are required.", 400);
  if (hasPlayer(ctx.store, p.xId)) throw new WorkshopError("duplicate_player", "One player per X account. This one already plays.", 409);
  return ctx.store.append("workshop.player", `x:${p.xId}`, { xId: p.xId, handle: p.handle, createdAt: p.createdAt }, "public", new Date(ctx.now()).toISOString());
}

const nextId = (store: EventStore, type: string, prefix: string): string => {
  const n = store.all().filter((e) => e.type === type).length + 1;
  return `${prefix}-${String(n).padStart(4, "0")}`;
};

export interface IdeaInput {
  author: string; // x id
  kind: string;
  title: string;
  pitch: string;
  incentive: string;
}

export function addIdea(ctx: WorkshopCtx, input: IdeaInput): RoomEvent {
  assertCoordinator(ctx);
  assertOpen(ctx);
  if (!hasPlayer(ctx.store, input.author)) throw new WorkshopError("not_a_player", "Sign in with X and verify before submitting ideas.", 403);
  const mine = ctx.store.all().filter((e) => e.type === "workshop.idea" && (e.payload as any).author === input.author).length;
  if (mine >= ctx.config.ideasPerPlayer)
    throw new WorkshopError("idea_limit", `At most ${ctx.config.ideasPerPlayer} ideas per player.`, 400);
  if (input.kind !== "game" && input.kind !== "video") throw new WorkshopError("bad_idea", 'kind must be "game" or "video".', 400);
  const title = input.title.trim().slice(0, 80);
  const pitch = input.pitch.trim().slice(0, 500);
  const incentive = input.incentive.trim().slice(0, 200);
  if (!title || !pitch || !incentive) throw new WorkshopError("bad_idea", "title, pitch and incentive are all required.", 400);
  return ctx.store.append(
    "workshop.idea",
    `x:${input.author}`,
    { id: nextId(ctx.store, "workshop.idea", "W"), author: input.author, kind: input.kind, title, pitch, incentive, createdAt: new Date(ctx.now()).toISOString() },
    "public",
    new Date(ctx.now()).toISOString(),
  );
}

export function setVotes(ctx: WorkshopCtx, voter: string, allocation: Record<string, number>): RoomEvent {
  assertCoordinator(ctx);
  assertOpen(ctx);
  if (!hasPlayer(ctx.store, voter)) throw new WorkshopError("not_a_player", "Sign in with X and verify before voting.", 403);
  if (!allocation || typeof allocation !== "object" || Array.isArray(allocation))
    throw new WorkshopError("bad_votes", "Votes are a full allocation: {ideaId: weight}.", 400);
  const ideas = new Set(ctx.store.all().filter((e) => e.type === "workshop.idea").map((e) => (e.payload as any).id));
  const clean: Record<string, number> = {};
  let total = 0;
  for (const [ideaId, w] of Object.entries(allocation)) {
    if (!ideas.has(ideaId)) throw new WorkshopError("unknown_idea", `No idea ${ideaId}.`, 400);
    if (!Number.isInteger(w) || w < 0) throw new WorkshopError("bad_votes", `Weight for ${ideaId} must be a whole number of points.`, 400);
    if (w > ctx.config.voteMaxPerIdea) throw new WorkshopError("vote_cap", `At most ${ctx.config.voteMaxPerIdea} points on one idea.`, 400);
    if (w > 0) clean[ideaId] = w;
    total += w;
  }
  if (total > ctx.config.voteBudget) throw new WorkshopError("vote_budget", `Each player has ${ctx.config.voteBudget} vote points; ${total} were assigned.`, 400);
  return ctx.store.append("workshop.votes", `x:${voter}`, { voter, allocation: clean, at: new Date(ctx.now()).toISOString() }, "public", new Date(ctx.now()).toISOString());
}

export function addBuild(ctx: WorkshopCtx, b: { ideaId: string; url: string; note: string; by: string }): RoomEvent {
  assertCoordinator(ctx);
  assertOpen(ctx);
  const idea = ctx.store.all().some((e) => e.type === "workshop.idea" && (e.payload as any).id === b.ideaId);
  if (!idea) throw new WorkshopError("unknown_idea", `No idea ${b.ideaId}.`, 400);
  if (!/^https?:\/\//.test(b.url)) throw new WorkshopError("bad_build", "Build url must be http(s).", 400);
  return ctx.store.append(
    "workshop.build",
    b.by,
    { ideaId: b.ideaId, url: b.url, note: b.note.trim().slice(0, 500), builtAt: new Date(ctx.now()).toISOString() },
    "public",
    new Date(ctx.now()).toISOString(),
  );
}

export interface EnergyDeclaration {
  watts: number;
  source: string; // self-attested claim; the evidence link is recorded, not verified
  evidenceUrl: string;
  budgetWh: number; // energy lease: ends when receipted Wh reaches this
}

export interface PayoutProfile {
  qi: number;
  quai: number;
  fiat: number;
  schedule: string; // now | lump_at:<ISO date> | stream:<n>x<P1D|P7D|P30D>
}

export function checkEnergy(e: any): asserts e is EnergyDeclaration {
  if (typeof e?.watts !== "number" || !(e.watts > 0)) throw new WorkshopError("bad_energy", "energy.watts must be a positive number.", 400);
  if (typeof e?.source !== "string" || !e.source.trim()) throw new WorkshopError("bad_energy", "energy.source is required (self-attested).", 400);
  if (typeof e?.evidenceUrl !== "string" || !/^https?:\/\//.test(e.evidenceUrl))
    throw new WorkshopError("bad_energy", "energy.evidenceUrl must be http(s).", 400);
  if (typeof e?.budgetWh !== "number" || !(e.budgetWh > 0)) throw new WorkshopError("bad_energy", "energy.budgetWh must be a positive number.", 400);
}

export function checkPayout(p: any): asserts p is PayoutProfile {
  for (const k of ["qi", "quai", "fiat"] as const)
    if (typeof p?.[k] !== "number" || p[k] < 0 || !Number.isFinite(p[k]))
      throw new WorkshopError("bad_payout", `payout.${k} must be a non-negative number.`, 400);
  if (Math.abs(p.qi + p.quai + p.fiat - 1) > 1e-9)
    throw new WorkshopError("bad_payout", `payout fractions must sum to 1 (got ${p.qi + p.quai + p.fiat}).`, 400);
  if (!parseSchedule(p.schedule)) throw new WorkshopError("bad_payout", "payout.schedule must be now, lump_at:<ISO date> or stream:<n>x<P1D|P7D|P30D>.", 400);
}

/** What the operator signs at registration (self-certifying: verifies against the claimed key). */
export const registrationMessage = (b: { url: string; publicKey: unknown; energy: unknown; payout: unknown }): Buffer =>
  Buffer.from(canonical({ url: b.url, publicKey: b.publicKey, energy: b.energy, payout: b.payout }), "utf8");

/** What the operator signs on payout updates (verifies against the registered key). */
export const payoutMessage = (nodeId: string, payout: unknown): Buffer => Buffer.from(canonical({ nodeId, payout }), "utf8");

export function verifyNodeSig(publicKey: Record<string, unknown>, msg: Buffer, sigBase64: string): boolean {
  try {
    const key = createPublicKey({ key: publicKey as any, format: "jwk" });
    return verify(null, msg, key, Buffer.from(sigBase64, "base64"));
  } catch {
    return false;
  }
}

export interface RegisterInput {
  operator: string;
  url: string;
  publicKey: Record<string, unknown>;
  nodeId?: string; // only the producer node id may be claimed, by allow-listed operators
  energy: EnergyDeclaration;
  payout: PayoutProfile;
  sig: string; // base64 Ed25519 over registrationMessage, made with the node key
}

export function registerNode(ctx: WorkshopCtx, r: RegisterInput): { event: RoomEvent; nodeId: string } {
  assertCoordinator(ctx);
  assertOpen(ctx);
  if (!hasPlayer(ctx.store, r.operator)) throw new WorkshopError("not_a_player", "Link an X account at the coordinator before registering a node.", 403);
  if (!/^https?:\/\//.test(r.url)) throw new WorkshopError("bad_node", "Node url must be http(s).", 400);
  if (!r.publicKey || typeof r.publicKey !== "object" || (r.publicKey as any).kty !== "OKP" || (r.publicKey as any).crv !== "Ed25519" || typeof (r.publicKey as any).x !== "string")
    throw new WorkshopError("bad_node", "publicKey must be an Ed25519 JWK.", 400);
  let nodeId: string;
  if (r.nodeId !== undefined && r.nodeId !== null && r.nodeId !== "") {
    if (r.nodeId !== ctx.config.producerNode.nodeId) throw new WorkshopError("bad_node", "Node ids are assigned; only the producer node id may be claimed.", 400);
    if (!ctx.config.producerNode.allow.includes(r.operator)) throw new WorkshopError("bad_node", "The producer node id is reserved.", 403);
    if (isKnownNode(ctx.store, r.nodeId)) throw new WorkshopError("duplicate_node", "That node id is already registered.", 409);
    nodeId = r.nodeId;
  } else {
    nodeId = nextId(ctx.store, "workshop.node_registered", "N");
  }
  checkEnergy(r.energy);
  checkPayout(r.payout);
  if (typeof r.sig !== "string" || !verifyNodeSig(r.publicKey, registrationMessage({ url: r.url, publicKey: r.publicKey, energy: r.energy, payout: r.payout }), r.sig))
    throw new WorkshopError("bad_signature", "Registration signature does not verify against the node key.", 401);
  const at = new Date(ctx.now()).toISOString();
  const event = ctx.store.append(
    "workshop.node_registered",
    `x:${r.operator}`,
    { nodeId, operator: r.operator, url: r.url, publicKey: r.publicKey, energy: r.energy, payout: r.payout },
    "public",
    at,
  );
  ctx.store.append("payout.profile.set", `x:${r.operator}`, { nodeId, operator: r.operator, payout: r.payout, at }, "public", at);
  return { event, nodeId };
}

/** Update a node's payout profile (operator session + node-key signature). Last one before close wins. */
export function setPayout(ctx: WorkshopCtx, s: { nodeId: string; payout: PayoutProfile; byOperator: string; sig: string }): RoomEvent {
  assertCoordinator(ctx);
  assertOpen(ctx);
  const reg = ctx.store
    .all()
    .filter((e) => e.type === "workshop.node_registered" && (e.payload as any).nodeId === s.nodeId)
    .at(-1)?.payload as any;
  if (!reg) throw new WorkshopError("unknown_node", `No node ${s.nodeId}. Register first.`, 404);
  if (reg.operator !== s.byOperator) throw new WorkshopError("not_your_node", "Only the node's operator can change its payout profile.", 403);
  checkPayout(s.payout);
  if (typeof s.sig !== "string" || !verifyNodeSig(reg.publicKey, payoutMessage(s.nodeId, s.payout), s.sig))
    throw new WorkshopError("bad_signature", "Payout signature does not verify against the registered node key.", 401);
  return ctx.store.append("payout.profile.set", `x:${s.byOperator}`, { nodeId: s.nodeId, operator: s.byOperator, payout: s.payout, at: new Date(ctx.now()).toISOString() }, "public", new Date(ctx.now()).toISOString());
}

export interface HeartbeatCounts {
  eventsVerified: number; // mirror size the node verified
  requestsServed: number; // requests the node served, cumulative
  head: string; // chain head the node verified ("genesis" when empty)
}

/** What a node signs every 60s: id, time, work counts and the head it verified. */
export const heartbeatMessage = (nodeId: string, at: string, counts: HeartbeatCounts): Buffer =>
  Buffer.from(canonical({ nodeId, at, eventsVerified: counts.eventsVerified, requestsServed: counts.requestsServed, head: counts.head }), "utf8");

export function verifyHeartbeatSig(publicKey: Record<string, unknown>, nodeId: string, at: string, counts: HeartbeatCounts, sigBase64: string): boolean {
  return verifyNodeSig(publicKey, heartbeatMessage(nodeId, at, counts), sigBase64);
}

/** A node's ended lease, if any (first node.lease.ended wins). */
export function leaseOf(store: EventStore, nodeId: string): { ended: boolean; reason: string | null } {
  const e = store.all().find((e) => e.type === "node.lease.ended" && (e.payload as any).nodeId === nodeId);
  return e ? { ended: true, reason: (e.payload as any).reason } : { ended: false, reason: null };
}

/** A player's permanent node binding (first sign-in wins), or null if unbound. */
export function attributionOf(store: EventStore, xId: string): string | null {
  const e = store.all().find((e) => e.type === "player.attributed" && (e.payload as any).player === xId);
  return e ? ((e.payload as any).nodeId as string) : null;
}

export function isKnownNode(store: EventStore, nodeId: string): boolean {
  return store.all().some((e) => e.type === "workshop.node_registered" && (e.payload as any).nodeId === nodeId);
}

export interface CommunityNodeLink {
  nodeId: string;
  url: string;
  signIn: string;
}

/** Registered community nodes (never the producer node) with sign-in links. */
export function communityNodes(store: EventStore, config: WorkshopConfig): CommunityNodeLink[] {
  const out: CommunityNodeLink[] = [];
  for (const e of store.all()) {
    if (e.type !== "workshop.node_registered") continue;
    const r = e.payload as { nodeId: string; url: string };
    if (r.nodeId === config.producerNode.nodeId || out.some((n) => n.nodeId === r.nodeId)) continue;
    const base = r.url.replace(/\/$/, "");
    out.push({ nodeId: r.nodeId, url: r.url, signIn: `${base}/api/workshop/auth/x/start?via=${encodeURIComponent(r.nodeId)}` });
  }
  return out;
}

function refuseToCommunity(store: EventStore, config: WorkshopConfig): never {
  throw new WorkshopError(
    "sign_in_through_a_community_node",
    "The producer path admits allow-listed accounts only. Sign in through a community node instead.",
    403,
    { nodes: communityNodes(store, config) },
  );
}

/**
 * Where a first sign-in binds. Community via admits; the producer path
 * (producer node, coordinator, or no/unknown node) admits allow-listed
 * accounts to the producer node and refuses the rest — unless noViaPolicy is
 * "unassigned", which admits them with no operator credit. Re-sign-ins keep
 * their binding; this governs admission only.
 */
export function resolveAttributionTarget(ctx: WorkshopCtx, xId: string, via: string | null): string {
  const pn = ctx.config.producerNode;
  const known = via && isKnownNode(ctx.store, via) ? via : null;
  if (known && known !== pn.nodeId) return known;
  if (!pn.allow.includes(xId)) {
    if (!known && ctx.config.noViaPolicy === "unassigned") return "unassigned";
    refuseToCommunity(ctx.store, ctx.config);
  }
  if (attributionOf(ctx.store, xId) === pn.nodeId) return pn.nodeId;
  if (countAttributionsTo(ctx.store.all(), pn.nodeId) >= pn.maxPlayers) refuseToCommunity(ctx.store, ctx.config);
  return pn.nodeId;
}

/**
 * Bind a player to the node they came through. First binding only: later
 * sign-ins keep the original (and are never refused for it).
 */
export function attributePlayer(ctx: WorkshopCtx, xId: string, via: string | null): RoomEvent | null {
  assertCoordinator(ctx);
  assertOpen(ctx);
  if (attributionOf(ctx.store, xId) !== null) return null;
  const nodeId = resolveAttributionTarget(ctx, xId, via);
  return ctx.store.append("player.attributed", `x:${xId}`, { player: xId, nodeId }, "public", new Date(ctx.now()).toISOString());
}

// ---------------------------------------------------------------- workshares

export const OEMBED_URL = "https://publish.twitter.com/oembed?url=";
const SNOWFLAKE_EPOCH_MS = 1288834974657n; // X snowflake epoch

export function tweetIdFromUrl(url: string): string | null {
  const m = url.match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

/** Snowflake id -> authored time (ms). BigInt: ids exceed double precision. */
export function snowflakeTimeMs(tweetId: string): number | null {
  try {
    return Number((BigInt(tweetId) >> 22n) + SNOWFLAKE_EPOCH_MS);
  } catch {
    return null;
  }
}

/** First path segment of an oEmbed author_url (its X handle), or null. */
export function handleFromAuthorUrl(authorUrl: string): string | null {
  try {
    const seg = new URL(authorUrl).pathname.split("/").filter(Boolean)[0];
    return seg ?? null;
  } catch {
    return null;
  }
}

const etDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export const etDay = (ms: number): string => etDayFmt.format(new Date(ms));

export function voidedUrls(store: EventStore): Set<string> {
  const out = new Set<string>();
  for (const e of store.all()) if (e.type === "workshare.voided") out.add((e.payload as any).url);
  return out;
}

/** Currently-counted workshares for a player on an ET day (voids excluded). */
export function countedOnDay(store: EventStore, player: string, day: string): number {
  const voided = voidedUrls(store);
  return store
    .all()
    .filter((e) => e.type === "workshare.recorded" && (e.payload as any).player === player && (e.payload as any).day === day && (e.payload as any).counted && !voided.has((e.payload as any).url)).length;
}

export interface WorkshareInput {
  player: string; // x id
  handle: string; // signed-in handle (must author the comment)
  url: string;
}

/**
 * Record a comment workshare after oEmbed verification: author match, snowflake
 * time in-window, never twice. Over the daily cap it is still logged, but not
 * counted. Thread membership is asserted by the player; the URL is the audit.
 */
export async function addWorkshare(
  ctx: WorkshopCtx,
  input: WorkshareInput,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ event: RoomEvent; counted: boolean; reason: string | null; tweetId: string; tweetedAt: string; day: string }> {
  assertCoordinator(ctx);
  assertOpen(ctx);
  if (!hasPlayer(ctx.store, input.player)) throw new WorkshopError("not_a_player", "Sign in with X and verify before submitting workshares.", 403);
  const url = input.url.trim();
  const tweetId = tweetIdFromUrl(url);
  if (!tweetId) throw new WorkshopError("bad_url", "Submit the URL of an X comment (…/status/<id>).", 400);
  if (ctx.store.all().some((e) => e.type === "workshare.recorded" && (e.payload as any).url === url))
    throw new WorkshopError("duplicate_workshare", "This URL was already submitted. Each comment counts once.", 409);
  let meta: any;
  try {
    const res = await fetchImpl(`${OEMBED_URL}${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    meta = await res.json();
  } catch (e: any) {
    throw new WorkshopError("oembed_failed", `X oEmbed verification failed: ${e?.message ?? e}`, 502);
  }
  const author = handleFromAuthorUrl(String(meta?.author_url ?? ""));
  if (!author || author.toLowerCase() !== input.handle.toLowerCase())
    throw new WorkshopError("author_mismatch", "That comment is not yours: its author does not match your X handle.", 403);
  const tweetedMs = snowflakeTimeMs(tweetId);
  const tweetedAt = tweetedMs === null ? null : new Date(tweetedMs).toISOString();
  if (tweetedMs === null || tweetedMs < Date.parse(ctx.config.opensAt) || tweetedMs > Date.parse(ctx.config.closesAt))
    throw new WorkshopError("out_of_window", "That comment was posted outside the workshop window.", 400);
  const day = etDay(tweetedMs);
  const counted = countedOnDay(ctx.store, input.player, day) < ctx.config.workshareCapPerDay;
  const event = ctx.store.append(
    "workshare.recorded",
    `x:${input.player}`,
    { url, player: input.player, handle: input.handle, tweetId, tweetedAt, day, counted },
    "public",
    new Date(ctx.now()).toISOString(),
  );
  return { event, counted, reason: counted ? null : "daily_cap", tweetId, tweetedAt: tweetedAt!, day };
}

/** The producer voids a workshare; its weight is gone (the history stays). */
export function voidWorkshare(ctx: WorkshopCtx, v: { url: string; reason: string; by: string }): RoomEvent {
  assertCoordinator(ctx);
  assertOpen(ctx);
  const url = v.url.trim();
  if (!ctx.store.all().some((e) => e.type === "workshare.recorded" && (e.payload as any).url === url))
    throw new WorkshopError("unknown_workshare", "No submitted workshare has that URL.", 404);
  if (voidedUrls(ctx.store).has(url)) throw new WorkshopError("already_voided", "That workshare is already voided.", 409);
  if (!v.reason.trim()) throw new WorkshopError("bad_void", "A reason is required.", 400);
  return ctx.store.append("workshare.voided", v.by, { url, reason: v.reason.trim().slice(0, 500) }, "public", new Date(ctx.now()).toISOString());
}

export function addHeartbeat(ctx: WorkshopCtx, h: { nodeId: string; at: string; sig: string } & HeartbeatCounts): RoomEvent {
  assertCoordinator(ctx);
  assertOpen(ctx);
  const reg = ctx.store
    .all()
    .filter((e) => e.type === "workshop.node_registered" && (e.payload as any).nodeId === h.nodeId)
    .at(-1)?.payload as any;
  if (!reg) throw new WorkshopError("unknown_node", `No node ${h.nodeId}. Register first.`, 400);
  if (leaseOf(ctx.store, h.nodeId).ended) throw new WorkshopError("lease_ended", "This node's energy lease has ended.", 403);
  const atMs = Date.parse(h.at);
  if (!Number.isFinite(atMs)) throw new WorkshopError("bad_heartbeat", "at must be an ISO timestamp.", 400);
  if (Math.abs(ctx.now() - atMs) > ctx.config.heartbeatSkewSecs * 1000)
    throw new WorkshopError("stale_heartbeat", `Heartbeat is outside the ${ctx.config.heartbeatSkewSecs}s skew window.`, 400);
  for (const k of ["eventsVerified", "requestsServed"] as const)
    if (!Number.isInteger(h[k]) || h[k] < 0) throw new WorkshopError("bad_heartbeat", `${k} must be a non-negative integer.`, 400);
  if (typeof h.head !== "string" || !h.head) throw new WorkshopError("bad_heartbeat", "head is required.", 400);
  // The coordinator checks the reported head against its own chain.
  if (h.head !== "genesis" && !ctx.store.all().some((e) => e.hash === h.head))
    throw new WorkshopError("bad_head", "Reported chain head is not on this chain.", 400);
  const counts: HeartbeatCounts = { eventsVerified: h.eventsVerified, requestsServed: h.requestsServed, head: h.head };
  if (typeof h.sig !== "string" || !verifyHeartbeatSig(reg.publicKey, h.nodeId, h.at, counts, h.sig))
    throw new WorkshopError("bad_heartbeat", "Heartbeat signature does not verify against the registered key.", 401);
  return ctx.store.append("workshop.heartbeat", `node:${h.nodeId}`, { nodeId: h.nodeId, at: h.at, sig: h.sig, ...counts }, "public", new Date(ctx.now()).toISOString());
}

// ---------------------------------------------------------------- receipts + leases

const floorHour = (ms: number): number => Math.floor(ms / 3_600_000) * 3_600_000;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

export interface ReceiptView {
  nodeId: string;
  hour: string;
  watts: number;
  hoursUp: number;
  wh: number;
  eventsVerified: number;
  requestsServed: number;
  heartbeats: number;
  source: string;
}

export function energyReceiptsOf(store: EventStore, nodeId?: string): ReceiptView[] {
  return store
    .all()
    .filter((e) => e.type === "energy.receipt" && (!nodeId || (e.payload as any).nodeId === nodeId))
    .map((e) => e.payload as ReceiptView);
}

/**
 * Derive hourly energy receipts and append them, so each receipt is fixed at
 * creation. Wh comes from heartbeats only (distinct up-minutes × declared
 * watts); the source claim is copied for audit, never verified. When a node's
 * cumulative receipted Wh reaches its budget, its lease ends. Coordinator
 * only; runs on the request tick before the close check.
 */
export function maybeReceipt(ctx: WorkshopCtx): RoomEvent[] {
  if (ctx.mode !== "coordinator") return [];
  const out: RoomEvent[] = [];
  const closesMs = Date.parse(ctx.config.closesAt);
  const horizon = isClosed(ctx.config, ctx.now()) ? closesMs : ctx.now();
  const endBound = floorHour(horizon);
  const regs = new Map<string, { energy: EnergyDeclaration; registeredAt: number }>();
  for (const e of ctx.store.all()) {
    if (e.type !== "workshop.node_registered") continue;
    const r = e.payload as any;
    if (!regs.has(r.nodeId) && r.energy) regs.set(r.nodeId, { energy: r.energy, registeredAt: Date.parse(e.ts) });
  }
  for (const [nodeId, reg] of regs) {
    const done = new Set(energyReceiptsOf(ctx.store, nodeId).map((r) => r.hour));
    for (let h = floorHour(reg.registeredAt); h < endBound; h += 3_600_000) {
      const hour = new Date(h).toISOString();
      if (done.has(hour)) continue;
      const beats = ctx.store
        .all()
        .filter((e) => e.type === "workshop.heartbeat" && (e.payload as any).nodeId === nodeId)
        .map((e) => e.payload as any)
        .filter((b) => {
          const t = Date.parse(b.at);
          return t >= h && t < h + 3_600_000;
        });
      const buckets = new Set(beats.map((b) => Math.floor(Date.parse(b.at) / 60_000)));
      const hoursUp = buckets.size / 60;
      out.push(
        ctx.store.append(
          "energy.receipt",
          "system",
          {
            nodeId,
            hour,
            watts: reg.energy.watts,
            hoursUp: round4(hoursUp),
            wh: round4(reg.energy.watts * hoursUp),
            eventsVerified: beats.reduce((m, b) => Math.max(m, Number(b.eventsVerified) || 0), 0),
            requestsServed: beats.reduce((m, b) => Math.max(m, Number(b.requestsServed) || 0), 0),
            heartbeats: beats.length,
            source: reg.energy.source,
          },
          "public",
          new Date(ctx.now()).toISOString(),
        ),
      );
    }
    if (!leaseOf(ctx.store, nodeId).ended) {
      const receiptedWh = energyReceiptsOf(ctx.store, nodeId).reduce((s, r) => s + r.wh, 0);
      if (receiptedWh >= reg.energy.budgetWh) {
        out.push(
          ctx.store.append(
            "node.lease.ended",
            "system",
            { nodeId, reason: "energy_budget", receiptedWh: round4(receiptedWh), budgetWh: reg.energy.budgetWh, at: new Date(ctx.now()).toISOString() },
            "public",
            new Date(ctx.now()).toISOString(),
          ),
        );
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- generation (priced in workshares, never money)

/** URLs already spent on generation. */
export function spentWorkshareUrls(store: EventStore): Set<string> {
  const out = new Set<string>();
  for (const e of store.all()) {
    if (e.type !== "generation.requested") continue;
    for (const u of ((e.payload as any).spentUrls as string[])) out.add(u);
  }
  return out;
}

/** Counted, unvoided, unspent workshares: the player's spendable balance. */
export function workshareBalance(store: EventStore, player: string): number {
  const voided = voidedUrls(store);
  const spent = spentWorkshareUrls(store);
  return store
    .all()
    .filter((e) => e.type === "workshare.recorded" && (e.payload as any).player === player && (e.payload as any).counted && !voided.has((e.payload as any).url) && !spent.has((e.payload as any).url)).length;
}

export function requestGeneration(ctx: WorkshopCtx, g: { player: string; ideaId: string }): { event: RoomEvent; id: string; spent: number; remaining: number } {
  assertCoordinator(ctx);
  assertOpen(ctx);
  if (!hasPlayer(ctx.store, g.player)) throw new WorkshopError("not_a_player", "Sign in with X and verify before requesting generation.", 403);
  if (!ctx.store.all().some((e) => e.type === "workshop.idea" && (e.payload as any).id === g.ideaId))
    throw new WorkshopError("unknown_idea", `No idea ${g.ideaId}.`, 404);
  const cost = ctx.config.generateCostWorkshares;
  const balance = workshareBalance(ctx.store, g.player);
  if (balance < cost) throw new WorkshopError("insufficient_workshares", `Generation costs ${cost} counted workshares; ${balance} available. It never charges money.`, 400);
  const voided = voidedUrls(ctx.store);
  const spent = spentWorkshareUrls(ctx.store);
  const candidates = ctx.store
    .all()
    .filter((e) => e.type === "workshare.recorded" && (e.payload as any).player === g.player && (e.payload as any).counted && !voided.has((e.payload as any).url) && !spent.has((e.payload as any).url))
    .map((e) => e.payload as any)
    .sort((a, b) => String(a.tweetedAt).localeCompare(String(b.tweetedAt)) || String(a.url).localeCompare(String(b.url)));
  const spentUrls = candidates.slice(0, cost).map((c) => c.url);
  const id = nextId(ctx.store, "generation.requested", "G");
  const event = ctx.store.append(
    "generation.requested",
    `x:${g.player}`,
    { id, ideaId: g.ideaId, player: g.player, cost, spentUrls, at: new Date(ctx.now()).toISOString() },
    "public",
    new Date(ctx.now()).toISOString(),
  );
  return { event, id, spent: cost, remaining: balance - cost };
}

// ---------------------------------------------------------------- v5: validated validators

/** A node's key fingerprint: what the operator posts in the thread to earn recruitment rights. */
export const nodeFingerprint = (publicKey: Record<string, unknown>): string => sha256(canonical(publicKey));

/** Pseudonymous subject id for the flags list (the subject is named only once appealed or resolved). */
export const subjectHash = (subject: string): string => sha256(subject).slice(0, 16);

/** Latest registration for a node, if any. */
function registrationOf(store: EventStore, nodeId: string): any | null {
  return store
    .all()
    .filter((e) => e.type === "workshop.node_registered" && (e.payload as any).nodeId === nodeId)
    .at(-1)?.payload as any ?? null;
}

/** First node.authorized wins; later ones are ignored. */
export function authorizationOf(store: EventStore, nodeId: string): string | null {
  const e = store.all().find((e) => e.type === "node.authorized" && (e.payload as any).nodeId === nodeId);
  return e ? ((e.payload as any).url as string) : null;
}

/** First node.revoked wins; revocation is permanent. */
export function revocationOf(store: EventStore, nodeId: string): { reason: string; at: string } | null {
  const e = store.all().find((e) => e.type === "node.revoked" && (e.payload as any).nodeId === nodeId);
  return e ? { reason: (e.payload as any).reason as string, at: (e.payload as any).at as string } : null;
}

/**
 * Authorize a node as a recruiter. The operator posts a reply in the thread
 * containing the node's key fingerprint; oEmbed must confirm the author and
 * the text must contain the fingerprint. Governance, so it stays open after
 * close: late evidence is what the challenge window is for.
 */
export async function authorizeNode(
  ctx: WorkshopCtx,
  a: { nodeId: string; url: string; byOperator: string; byHandle: string },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RoomEvent> {
  assertCoordinator(ctx);
  const reg = registrationOf(ctx.store, a.nodeId);
  if (!reg) throw new WorkshopError("unknown_node", `No node ${a.nodeId}. Register first.`, 404);
  if (reg.operator !== a.byOperator) throw new WorkshopError("not_your_node", "Only the node's operator can authorize it.", 403);
  if (revocationOf(ctx.store, a.nodeId)) throw new WorkshopError("node_revoked", "This node was revoked by the producer.", 409);
  if (authorizationOf(ctx.store, a.nodeId)) throw new WorkshopError("already_authorized", "This node is already an authorized recruiter.", 409);
  const url = a.url.trim();
  if (!tweetIdFromUrl(url)) throw new WorkshopError("bad_url", "Authorize with the URL of the operator's thread reply (…/status/<id>).", 400);
  let meta: any;
  try {
    const res = await fetchImpl(`${OEMBED_URL}${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    meta = await res.json();
  } catch (e: any) {
    throw new WorkshopError("oembed_failed", `X oEmbed verification failed: ${e?.message ?? e}`, 502);
  }
  const author = handleFromAuthorUrl(String(meta?.author_url ?? ""));
  if (!author || author.toLowerCase() !== a.byHandle.toLowerCase())
    throw new WorkshopError("author_mismatch", "That reply is not the operator's: its author does not match.", 403);
  if (!String(meta?.html ?? "").includes(nodeFingerprint(reg.publicKey)))
    throw new WorkshopError("missing_fingerprint", "That reply does not contain the node's key fingerprint.", 400);
  return ctx.store.append("node.authorized", `x:${a.byOperator}`, { nodeId: a.nodeId, url, at: new Date(ctx.now()).toISOString() }, "public", new Date(ctx.now()).toISOString());
}

// ---------------------------------------------------------------- v5: audits

/** What a node signs when challenged: its id, the event seq, that event's hash, its chain head. */
export const auditMessage = (nodeId: string, k: number, hash: string, head: string): Buffer =>
  Buffer.from(canonical({ nodeId, k, hash, head }), "utf8");

export interface AuditProof {
  nodeId: string;
  k: number;
  hash: string;
  head: string;
  sig: string;
}

/** A reported head is honest when it is genesis or an event hash on this chain (a lagging node is still honest). */
function headIsHonest(events: readonly RoomEvent[], head: string): boolean {
  return head === "genesis" || events.some((e) => e.hash === head);
}

/**
 * One coordinator spot check against a live node: fetch its signed proof for
 * event k and compare against this chain. Anything wrong — timeout, bad
 * signature, wrong hash, unknown head — is a fail. Logs node.audit either way.
 */
export async function runAudit(ctx: WorkshopCtx, nodeId: string, k?: number, fetchImpl: typeof fetch = globalThis.fetch): Promise<{ event: RoomEvent; pass: boolean }> {
  assertCoordinator(ctx);
  const reg = registrationOf(ctx.store, nodeId);
  if (!reg) throw new WorkshopError("unknown_node", `No node ${nodeId}. Register first.`, 404);
  const events = ctx.store.all();
  const seq = k ?? (events.length ? 1 + Math.floor(Math.random() * events.length) : 0);
  const target = events.find((e) => e.seq === seq);
  if (!target) throw new WorkshopError("bad_audit", `No event with seq ${seq} on this chain.`, 400);
  let proof: AuditProof | null = null;
  try {
    const res = await fetchImpl(`${reg.url.replace(/\/$/, "")}/api/workshop/audit-proof?k=${seq}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    proof = (await res.json()) as AuditProof;
  } catch {
    proof = null; // silence is a fail
  }
  const pass =
    proof !== null &&
    proof.nodeId === nodeId &&
    proof.k === seq &&
    typeof proof.sig === "string" &&
    verifyNodeSig(reg.publicKey, auditMessage(nodeId, seq, proof.hash, proof.head), proof.sig) &&
    proof.hash === target.hash &&
    headIsHonest(events, proof.head);
  const event = ctx.store.append(
    "node.audit",
    "system",
    { nodeId, result: pass ? "pass" : "fail", k: seq, via: "coordinator", at: new Date(ctx.now()).toISOString() },
    "public",
    new Date(ctx.now()).toISOString(),
  );
  return { event, pass };
}

/**
 * A peer node reports another's signed audit answer. The coordinator confirms
 * it against its own chain: a correct report of a failing node earns the
 * reporter a bounty (see deriveBountyClaims); a wrong report just records the
 * target's signed pass. The signature must verify against the target's key,
 * so reports can't be fabricated.
 */
export function reportPeerAudit(
  ctx: WorkshopCtx,
  r: { reporterNode: string; target: string; k: number; hash: string; head: string; sig: string; byOperator: string },
): { event: RoomEvent; confirmed: boolean } {
  assertCoordinator(ctx);
  const reporter = registrationOf(ctx.store, r.reporterNode);
  if (!reporter) throw new WorkshopError("unknown_node", `No node ${r.reporterNode}. Register first.`, 404);
  if (reporter.operator !== r.byOperator) throw new WorkshopError("not_your_node", "Only the reporting node's operator can file its audits.", 403);
  const treg = registrationOf(ctx.store, r.target);
  if (!treg) throw new WorkshopError("unknown_node", `No node ${r.target}. Register first.`, 404);
  const events = ctx.store.all();
  const target = events.find((e) => e.seq === r.k);
  if (!target) throw new WorkshopError("bad_audit", `No event with seq ${r.k} on this chain.`, 400);
  if (typeof r.sig !== "string" || !verifyNodeSig(treg.publicKey, auditMessage(r.target, r.k, r.hash, r.head), r.sig))
    throw new WorkshopError("bad_signature", "That answer is not signed by the target node's key.", 400);
  const healthy = r.hash === target.hash && headIsHonest(events, r.head);
  const event = ctx.store.append(
    "node.audit",
    `x:${r.byOperator}`,
    { nodeId: r.target, result: healthy ? "pass" : "fail", k: r.k, via: "peer", reporterNode: r.reporterNode, at: new Date(ctx.now()).toISOString() },
    "public",
    new Date(ctx.now()).toISOString(),
  );
  return { event, confirmed: !healthy };
}

// ---------------------------------------------------------------- v5: flags, quarantine, appeals

export interface FlagInput {
  subject: string; // player x id, node id, or "handle:<x handle>" for thread-only subjects
  subjectKind: "player" | "node";
  signal: string; // attribution_burst | new_account_cluster | audit_fail_growth | canary:* | abuse_report | pretender_claim
  evidence: unknown;
  reporter?: string; // x id of a signed-in reporter; system detections have none
}

/** File a flag. Quarantine, not deletion: the weight is held while the flag is open or upheld. */
export function raiseFlag(ctx: WorkshopCtx, f: FlagInput, by: string): RoomEvent {
  assertCoordinator(ctx);
  if (!f.subject || typeof f.subject !== "string") throw new WorkshopError("bad_flag", "A subject is required.", 400);
  if (f.subjectKind !== "player" && f.subjectKind !== "node") throw new WorkshopError("bad_flag", 'subjectKind must be "player" or "node".', 400);
  if (!f.signal || typeof f.signal !== "string") throw new WorkshopError("bad_flag", "A signal is required.", 400);
  if (f.evidence === undefined) throw new WorkshopError("bad_flag", "Evidence is required.", 400);
  return ctx.store.append(
    "flag.raised",
    by,
    { id: nextId(ctx.store, "flag.raised", "F"), subject: f.subject, subjectKind: f.subjectKind, signal: f.signal, evidence: f.evidence, reporter: f.reporter ?? null, at: new Date(ctx.now()).toISOString() },
    "public",
    new Date(ctx.now()).toISOString(),
  );
}

function flagById(store: EventStore, id: string): any | null {
  return store.all().find((e) => e.type === "flag.raised" && (e.payload as any).id === id)?.payload as any ?? null;
}

export function flagResolved(store: EventStore, id: string): { decision: string; note: string } | null {
  const e = store.all().find((e) => e.type === "flag.resolved" && (e.payload as any).id === id);
  return e ? { decision: (e.payload as any).decision as string, note: (e.payload as any).note as string } : null;
}

/** The flagged subject appeals. Only the subject's own session can file it. */
export function appealFlag(ctx: WorkshopCtx, a: { id: string; reason: string; xId: string; handle: string }): RoomEvent {
  assertCoordinator(ctx);
  const flag = flagById(ctx.store, a.id);
  if (!flag) throw new WorkshopError("unknown_flag", `No flag ${a.id}.`, 404);
  if (flagResolved(ctx.store, a.id)) throw new WorkshopError("flag_resolved", "That flag is already resolved.", 409);
  if (ctx.store.all().some((e) => e.type === "flag.appealed" && (e.payload as any).id === a.id))
    throw new WorkshopError("already_appealed", "That flag already has an appeal.", 409);
  const mine = flag.subjectKind === "player" && (flag.subject === a.xId || flag.subject === `handle:${a.handle.toLowerCase()}`);
  if (!mine) throw new WorkshopError("not_your_flag", "Only the flagged subject can appeal.", 403);
  if (!a.reason.trim()) throw new WorkshopError("bad_appeal", "A reason is required.", 400);
  return ctx.store.append("flag.appealed", `x:${a.xId}`, { id: a.id, reason: a.reason.trim().slice(0, 500), at: new Date(ctx.now()).toISOString() }, "public", new Date(ctx.now()).toISOString());
}

/** The producer resolves a flag publicly. Cleared restores the weight; upheld forfeits it. */
export function resolveFlag(ctx: WorkshopCtx, r: { id: string; decision: string; note: string; by: string }): RoomEvent {
  assertCoordinator(ctx);
  const flag = flagById(ctx.store, r.id);
  if (!flag) throw new WorkshopError("unknown_flag", `No flag ${r.id}.`, 404);
  if (flagResolved(ctx.store, r.id)) throw new WorkshopError("flag_resolved", "That flag is already resolved.", 409);
  if (r.decision !== "upheld" && r.decision !== "cleared") throw new WorkshopError("bad_flag", 'decision must be "upheld" or "cleared".', 400);
  if (!r.note.trim()) throw new WorkshopError("bad_flag", "A public note is required.", 400);
  return ctx.store.append(
    "flag.resolved",
    r.by,
    { id: r.id, decision: r.decision, note: r.note.trim().slice(0, 500), at: new Date(ctx.now()).toISOString() },
    "public",
    new Date(ctx.now()).toISOString(),
  );
}

/**
 * Coordinator gaming detection, run on the request tick. Bursts of sign-ins
 * through one node, clusters of post-opens accounts, and nodes that keep
 * recruiting while their audits fail. Each (subject, signal) raises once while
 * active; only resolutions clear. The remaining signals (duplicate text,
 * off-thread URLs, fixed schedules) arrive as signed-in abuse reports, since
 * they need thread context the log doesn't have.
 */
export function detectGaming(ctx: WorkshopCtx): RoomEvent[] {
  if (ctx.mode !== "coordinator") return [];
  const out: RoomEvent[] = [];
  const events = ctx.store.all();
  const active = new Set<string>();
  for (const f of deriveFlags(events)) {
    if (f.status !== "cleared") active.add(`${f.subjectKind}:${flagSubjectOf(events, f.id)}:${f.signal}`);
  }
  const raise = (subject: string, subjectKind: "player" | "node", signal: string, evidence: unknown): void => {
    if (active.has(`${subjectKind}:${subject}:${signal}`)) return;
    active.add(`${subjectKind}:${subject}:${signal}`);
    out.push(raiseFlag(ctx, { subject, subjectKind, signal, evidence }, "system"));
  };
  // Sign-ins per node per UTC hour.
  const bursts = new Map<string, { nodeId: string; hour: string; count: number }>();
  for (const e of events) {
    if (e.type !== "player.attributed") continue;
    const nodeId = (e.payload as any).nodeId as string;
    if (nodeId === "unassigned") continue;
    const hour = new Date(floorHour(Date.parse(e.ts))).toISOString();
    const k = `${nodeId}:${hour}`;
    const b = bursts.get(k) ?? { nodeId, hour, count: 0 };
    b.count++;
    bursts.set(k, b);
  }
  for (const b of bursts.values()) {
    if (b.count > ctx.config.attributionBurstThreshold) raise(b.nodeId, "node", "attribution_burst", { hour: b.hour, attributions: b.count });
  }
  // Post-opens accounts per node.
  const opensMs = Date.parse(ctx.config.opensAt);
  const created = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "workshop.player") continue;
    const p = e.payload as { xId: string; createdAt: string };
    if (!created.has(p.xId)) created.set(p.xId, p.createdAt);
  }
  const clusters = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "player.attributed") continue;
    const a = e.payload as { player: string; nodeId: string };
    if (a.nodeId === "unassigned") continue;
    if (Date.parse(created.get(a.player) ?? "") > opensMs) clusters.set(a.nodeId, (clusters.get(a.nodeId) ?? 0) + 1);
  }
  for (const [nodeId, count] of clusters) {
    if (count > ctx.config.newAccountClusterThreshold) raise(nodeId, "node", "new_account_cluster", { postOpensAccounts: count });
  }
  // Nodes recruiting while their audits fail.
  const auditsByNode = new Map<string, { result: string; at: string }[]>();
  for (const e of events) {
    if (e.type !== "node.audit") continue;
    const a = e.payload as { nodeId: string; result: string; at: string };
    const list = auditsByNode.get(a.nodeId) ?? [];
    list.push({ result: a.result, at: a.at });
    auditsByNode.set(a.nodeId, list);
  }
  for (const [nodeId, list] of auditsByNode) {
    list.sort((x, y) => x.at.localeCompare(y.at));
    const latest = list.at(-1)!;
    if (latest.result !== "fail") continue;
    const grown = events.some((e) => e.type === "player.attributed" && (e.payload as any).nodeId === nodeId && e.ts > latest.at);
    if (grown) raise(nodeId, "node", "audit_fail_growth", { failedAt: latest.at });
  }
  return out;
}

function flagSubjectOf(events: readonly RoomEvent[], id: string): string {
  return (events.find((e) => e.type === "flag.raised" && (e.payload as any).id === id)?.payload as any)?.subject ?? "";
}

// ---------------------------------------------------------------- v5: proposed, challenged, final settlement

function proposalEvents(store: EventStore): RoomEvent[] {
  return store.all().filter((e) => e.type === "settlement.proposed");
}

export function latestProposal(store: EventStore): RoomEvent | null {
  return proposalEvents(store).at(-1) ?? null;
}

export function finalizationOf(store: EventStore): RoomEvent | null {
  return store.all().find((e) => e.type === "settlement.finalized") ?? null;
}

export function openChallenges(store: EventStore): string[] {
  const resolved = new Set(store.all().filter((e) => e.type === "challenge.resolved").map((e) => (e.payload as any).id as string));
  return store
    .all()
    .filter((e) => e.type === "challenge.filed" && !resolved.has((e.payload as any).id as string))
    .map((e) => (e.payload as any).id as string);
}

/** At close the coordinator proposes the settlement: formula, every input, amounts owed, hash. */
export function maybePropose(ctx: WorkshopCtx): RoomEvent | null {
  if (ctx.mode !== "coordinator") return null;
  if (!isClosed(ctx.config, ctx.now())) return null;
  if (latestProposal(ctx.store)) return null;
  const snap = settlementSnapshot(ctx.store.all(), ctx.config, ctx.now());
  const at = new Date(ctx.now()).toISOString();
  return ctx.store.append("settlement.proposed", "system", { at, formula: snap.formula, inputs: snap.inputs, operators: snap.operators, hash: snap.hash }, "public", at);
}

/** Anyone signed in can challenge the proposal during the window. Obligations only — challenges dispute amounts, never move money. */
export function fileChallenge(ctx: WorkshopCtx, c: { claim: string; evidence: string; by: string; handle: string }): RoomEvent {
  assertCoordinator(ctx);
  if (!latestProposal(ctx.store)) throw new WorkshopError("no_proposal", "Challenges open when the settlement is proposed at close.", 409);
  if (finalizationOf(ctx.store)) throw new WorkshopError("finalized", "The settlement is final; the window is closed.", 409);
  if (!c.claim.trim()) throw new WorkshopError("bad_challenge", "A claim is required.", 400);
  if (!c.evidence.trim()) throw new WorkshopError("bad_challenge", "Evidence is required.", 400);
  return ctx.store.append(
    "challenge.filed",
    `x:${c.by}`,
    { id: nextId(ctx.store, "challenge.filed", "C"), claim: c.claim.trim().slice(0, 500), evidence: c.evidence.trim().slice(0, 1000), by: c.by, handle: c.handle, at: new Date(ctx.now()).toISOString() },
    "public",
    new Date(ctx.now()).toISOString(),
  );
}

/**
 * The producer answers a challenge publicly. An accepted challenge that
 * changes amounts re-proposes the settlement, restarting the window.
 */
export function resolveChallenge(ctx: WorkshopCtx, r: { id: string; decision: string; note: string; by: string }): { event: RoomEvent; reproposed: RoomEvent | null } {
  assertCoordinator(ctx);
  const filed = ctx.store.all().some((e) => e.type === "challenge.filed" && (e.payload as any).id === r.id);
  if (!filed) throw new WorkshopError("unknown_challenge", `No challenge ${r.id}.`, 404);
  if (ctx.store.all().some((e) => e.type === "challenge.resolved" && (e.payload as any).id === r.id))
    throw new WorkshopError("challenge_resolved", "That challenge is already resolved.", 409);
  if (r.decision !== "accepted" && r.decision !== "rejected") throw new WorkshopError("bad_challenge", 'decision must be "accepted" or "rejected".', 400);
  if (!r.note.trim()) throw new WorkshopError("bad_challenge", "A public note is required.", 400);
  const event = ctx.store.append(
    "challenge.resolved",
    r.by,
    { id: r.id, decision: r.decision, note: r.note.trim().slice(0, 500), at: new Date(ctx.now()).toISOString() },
    "public",
    new Date(ctx.now()).toISOString(),
  );
  let reproposed: RoomEvent | null = null;
  if (r.decision === "accepted") {
    const snap = settlementSnapshot(ctx.store.all(), ctx.config, ctx.now());
    const latest = latestProposal(ctx.store)!;
    if (snap.hash !== ((latest.payload as any).hash as string)) {
      const at = new Date(ctx.now()).toISOString();
      reproposed = ctx.store.append("settlement.proposed", "system", { at, formula: snap.formula, inputs: snap.inputs, operators: snap.operators, hash: snap.hash }, "public", at);
    }
  }
  return { event, reproposed };
}

/** Finalize only when the window has ended and every challenge is resolved. */
export function finalizeSettlement(ctx: WorkshopCtx, by: string): RoomEvent {
  assertCoordinator(ctx);
  const latest = latestProposal(ctx.store);
  if (!latest) throw new WorkshopError("no_proposal", "Nothing to finalize: the settlement is proposed at close.", 409);
  if (finalizationOf(ctx.store)) throw new WorkshopError("already_final", "The settlement is already final.", 409);
  const windowEndsAt = new Date(Date.parse((latest.payload as any).at as string) + ctx.config.challengeWindowDays * 86_400_000).toISOString();
  if (ctx.now() < Date.parse(windowEndsAt))
    throw new WorkshopError("window_open", `The challenge window ends at ${windowEndsAt}.`, 409, { windowEndsAt });
  const open = openChallenges(ctx.store);
  if (open.length) throw new WorkshopError("challenges_open", `${open.length} challenge(s) still open: ${open.join(", ")}.`, 409, { open });
  return ctx.store.append("settlement.finalized", by, { hash: (latest.payload as any).hash as string, at: new Date(ctx.now()).toISOString() }, "public", new Date(ctx.now()).toISOString());
}
