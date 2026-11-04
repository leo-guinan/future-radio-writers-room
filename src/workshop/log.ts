// The workshop log: a hash-chained event store (the room's EventStore) kept in a
// separate file from the writers' room log. All writes flow through here so
// close enforcement, budgets and identity rules hold in code, not in prompts.

import { createPublicKey, verify } from "node:crypto";
import { join } from "node:path";
import { EventStore, sha256, canonical } from "../core/events.ts";
import type { RoomEvent } from "../core/types.ts";
import type { WorkshopConfig } from "./config.ts";
import { deriveScoreboard } from "./derive.ts";

export class WorkshopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
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

export function registerNode(ctx: WorkshopCtx, r: { operator: string; url: string; publicKey: Record<string, unknown> }): { event: RoomEvent; nodeId: string } {
  assertCoordinator(ctx);
  assertOpen(ctx);
  if (!hasPlayer(ctx.store, r.operator)) throw new WorkshopError("not_a_player", "Link an X account at the coordinator before registering a node.", 403);
  if (!/^https?:\/\//.test(r.url)) throw new WorkshopError("bad_node", "Node url must be http(s).", 400);
  if (!r.publicKey || typeof r.publicKey !== "object" || (r.publicKey as any).kty !== "OKP" || (r.publicKey as any).crv !== "Ed25519" || typeof (r.publicKey as any).x !== "string")
    throw new WorkshopError("bad_node", "publicKey must be an Ed25519 JWK.", 400);
  const nodeId = nextId(ctx.store, "workshop.node_registered", "N");
  const event = ctx.store.append(
    "workshop.node_registered",
    `x:${r.operator}`,
    { nodeId, operator: r.operator, url: r.url, publicKey: r.publicKey },
    "public",
    new Date(ctx.now()).toISOString(),
  );
  return { event, nodeId };
}

/** What a node signs: its id and the heartbeat time, Ed25519. */
export const heartbeatMessage = (nodeId: string, at: string): Buffer => Buffer.from(`${nodeId}|${at}`, "utf8");

export function verifyHeartbeatSig(publicKey: Record<string, unknown>, nodeId: string, at: string, sigBase64: string): boolean {
  try {
    const key = createPublicKey({ key: publicKey as any, format: "jwk" });
    return verify(null, heartbeatMessage(nodeId, at), key, Buffer.from(sigBase64, "base64"));
  } catch {
    return false;
  }
}

/** A player's permanent node binding (first sign-in wins), or null if unbound. */
export function attributionOf(store: EventStore, xId: string): string | null {
  const e = store.all().find((e) => e.type === "player.attributed" && (e.payload as any).player === xId);
  return e ? ((e.payload as any).nodeId as string) : null;
}

export function isKnownNode(store: EventStore, nodeId: string): boolean {
  return store.all().some((e) => e.type === "workshop.node_registered" && (e.payload as any).nodeId === nodeId);
}

/**
 * Bind a player to the node they came through. First binding only: later
 * sign-ins keep the original. Missing/unknown via binds to "coordinator".
 */
export function attributePlayer(ctx: WorkshopCtx, xId: string, via: string | null): RoomEvent | null {
  assertCoordinator(ctx);
  assertOpen(ctx);
  if (attributionOf(ctx.store, xId) !== null) return null;
  const nodeId = via && isKnownNode(ctx.store, via) ? via : "coordinator";
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

export function addHeartbeat(ctx: WorkshopCtx, h: { nodeId: string; at: string; sig: string }): RoomEvent {
  assertCoordinator(ctx);
  assertOpen(ctx);
  const reg = ctx.store
    .all()
    .filter((e) => e.type === "workshop.node_registered" && (e.payload as any).nodeId === h.nodeId)
    .at(-1)?.payload as any;
  if (!reg) throw new WorkshopError("unknown_node", `No node ${h.nodeId}. Register first.`, 400);
  const atMs = Date.parse(h.at);
  if (!Number.isFinite(atMs)) throw new WorkshopError("bad_heartbeat", "at must be an ISO timestamp.", 400);
  if (Math.abs(ctx.now() - atMs) > ctx.config.heartbeatSkewSecs * 1000)
    throw new WorkshopError("stale_heartbeat", `Heartbeat is outside the ${ctx.config.heartbeatSkewSecs}s skew window.`, 400);
  if (typeof h.sig !== "string" || !verifyHeartbeatSig(reg.publicKey, h.nodeId, h.at, h.sig))
    throw new WorkshopError("bad_heartbeat", "Heartbeat signature does not verify against the registered key.", 401);
  return ctx.store.append("workshop.heartbeat", `node:${h.nodeId}`, { nodeId: h.nodeId, at: h.at, sig: h.sig }, "public", new Date(ctx.now()).toISOString());
}
