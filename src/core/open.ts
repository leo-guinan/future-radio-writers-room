import { join } from "node:path";
import { EventStore } from "./events.ts";
import { Room } from "./room.ts";

export const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
export const LOG_PATH = join(DATA_DIR, "events.jsonl");

export function openRoom(path: string | null = LOG_PATH): Room {
  return new Room(new EventStore(path));
}
