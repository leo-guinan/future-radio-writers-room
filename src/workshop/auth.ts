// Identity: X OAuth 2.0 with PKCE. The coordinator holds the app credentials.
// Only the X user id, handle and account creation date are kept; the access
// token is discarded right after verification and never logged.

import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_ME_URL = "https://api.x.com/2/users/me?user.fields=created_at";
const SCOPES = "users.read tweet.read";

export const authEnv = () => ({
  clientId: process.env.X_CLIENT_ID ?? "",
  clientSecret: process.env.X_CLIENT_SECRET ?? "",
  callbackUrl: process.env.X_CALLBACK_URL ?? "",
  secret: process.env.WORKSHOP_SECRET ?? "",
});

export const authConfigured = (): boolean => {
  const e = authEnv();
  return Boolean(e.clientId && e.clientSecret && e.callbackUrl && e.secret);
};

const b64url = (b: Buffer): string => b.toString("base64url");
const unb64url = (s: string): Buffer => Buffer.from(s, "base64url");

// ---------------------------------------------------------------- PKCE

export interface PendingAuth {
  verifier: string;
  expires: number;
}

/** state -> verifier, single-use, 10-minute TTL. Keyed by random state. */
export const pendingAuth = new Map<string, PendingAuth>();

export function beginAuth(via?: string | null): { state: string; url: string } {
  const { clientId, callbackUrl, secret } = authEnv();
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const nonce = b64url(randomBytes(24));
  pendingAuth.set(nonce, { verifier, expires: Date.now() + 10 * 60_000 });
  // via travels inside the signed state, so only the coordinator needs X
  // credentials and players cannot forge their attribution.
  const payload = b64url(Buffer.from(JSON.stringify({ r: nonce, via: via ?? null }), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  const state = `${payload}.${sig}`;
  const url =
    `${X_AUTHORIZE_URL}?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
  return { state, url };
}

export function takeVerifier(signedState: string): { verifier: string; via: string | null } | null {
  try {
    const [payload, sig] = String(signedState).split(".");
    if (!payload || !sig) return null;
    const want = createHmac("sha256", authEnv().secret).update(payload).digest();
    const got = unb64url(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const { r, via } = JSON.parse(unb64url(payload).toString("utf8"));
    const p = pendingAuth.get(r);
    pendingAuth.delete(r);
    if (!p || p.expires < Date.now()) return null;
    return { verifier: p.verifier, via: typeof via === "string" ? via : null };
  } catch {
    return null;
  }
}

export interface XProfile {
  xId: string;
  handle: string;
  createdAt: string;
}

/** Exchange the code, fetch the profile, drop the token. Nothing persists it. */
export async function verifyCode(code: string, verifier: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<XProfile> {
  const { clientId, clientSecret, callbackUrl } = authEnv();
  const tokenRes = await fetchImpl(X_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl, code_verifier: verifier }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`X token exchange failed: HTTP ${tokenRes.status}`);
  const tokenBody = (await tokenRes.json().catch(() => ({}))) as any;
  const accessToken = String(tokenBody.access_token ?? "");
  if (!accessToken) throw new Error("X token exchange returned no access token.");
  try {
    const meRes = await fetchImpl(X_ME_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!meRes.ok) throw new Error(`X user lookup failed: HTTP ${meRes.status}`);
    const me = (await meRes.json().catch(() => ({}))) as any;
    const id = String(me?.data?.id ?? "");
    const handle = String(me?.data?.username ?? "");
    const createdAt = String(me?.data?.created_at ?? "");
    if (!id || !handle || !createdAt) throw new Error("X user lookup returned no id, handle or creation date.");
    return { xId: id, handle, createdAt };
  } finally {
    // The access token is out of scope past this point: never stored, never logged.
  }
}

// ---------------------------------------------------------------- sessions

export const SESSION_COOKIE = "workshop_session";
const SESSION_TTL_MS = 30 * 86_400_000;

export interface SessionPayload {
  xId: string;
  handle: string;
  iat: number;
  exp: number;
}

export function signSession(secret: string, p: { xId: string; handle: string }, nowMs = Date.now()): string {
  const payload: SessionPayload = { ...p, iat: nowMs, exp: nowMs + SESSION_TTL_MS };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(secret: string, cookieValue: string | null, nowMs = Date.now()): SessionPayload | null {
  try {
    if (!cookieValue) return null;
    const [body, sig] = cookieValue.split(".");
    if (!body || !sig) return null;
    const want = createHmac("sha256", secret).update(body).digest();
    const got = unb64url(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const p = JSON.parse(unb64url(body).toString("utf8")) as SessionPayload;
    if (typeof p.xId !== "string" || typeof p.handle !== "string" || p.exp < nowMs) return null;
    return p;
  } catch {
    return null;
  }
}

export function sessionCookieHeader(value: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;
}

export function cookieOf(req: IncomingMessage, name: string): string | null {
  const header = String(req.headers.cookie ?? "");
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

/** The verified session on this request, or null. Never throws. */
export function requestSession(req: IncomingMessage, nowMs = Date.now()): SessionPayload | null {
  return verifySession(authEnv().secret, cookieOf(req, SESSION_COOKIE), nowMs);
}
