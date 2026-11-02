// Live session registry. Controllers hold monotonic deadlines, so they live in
// memory; anything the log can rebuild is rebuilt after a restart.

import type { Room } from "../core/room.ts";
import { SessionController } from "./session.ts";

const live = new Map<string, SessionController>();

export function register(session: SessionController): SessionController {
  live.set(session.sessionId, session);
  return session;
}

export function getSession(room: Room, sessionId: string): SessionController {
  const s = live.get(sessionId);
  if (s) return s;
  const rebuilt = SessionController.rebuild(room, sessionId);
  live.set(sessionId, rebuilt);
  return rebuilt;
}

export function listSessions(room: Room): string[] {
  const ids = new Set<string>(live.keys());
  for (const e of room.store.all())
    if (e.type === "humain.session_opened") ids.add((e.payload as { sessionId: string }).sessionId);
  return [...ids].sort();
}
