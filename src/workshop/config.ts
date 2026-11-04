// Workshop config: window, scoring rules, limits, pledge. Everything the game
// derives from lives here visibly — no hardcoded reward amounts anywhere.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkshopConfig {
  opensAt: string; // ISO
  closesAt: string; // ISO; close is enforced in code at this time
  publicUrl: string;
  points: { idea: number; voteReceived: number; built: number; uptimeHour: number };
  voteBudget: number;
  voteMaxPerIdea: number;
  ideasPerPlayer: number;
  newAccountDays: number;
  heartbeatIntervalSecs: number;
  heartbeatWindowSecs: number;
  heartbeatSkewSecs: number;
  blockBonus: number; // player weight per built idea (a build is the "block")
  workshareCapPerDay: number; // counted workshares per player per ET day
  rewardAmount: number | null; // R: outside reward in dollars; null until the prize/debt amount is known
  pledge: {
    text: string; // verbatim from the Third Take episode
    ifWin: { participants: number; nextContest: number };
    ifLose: string;
    nodeOperatorShareOfParticipants: number | null; // set by the producer; null = "not set"
    prizeOutcome: "pending" | "won" | "lost";
  };
}

export const DEFAULT_CONFIG_PATH = () => join(process.cwd(), "demo", "workshop", "config.json");

export function loadWorkshopConfig(path = DEFAULT_CONFIG_PATH()): WorkshopConfig {
  if (!existsSync(path)) throw new Error(`Workshop config not found: ${path}`);
  const c = JSON.parse(readFileSync(path, "utf8")) as WorkshopConfig;
  for (const k of ["opensAt", "closesAt", "publicUrl"] as const)
    if (typeof c[k] !== "string" || !c[k]) throw new Error(`Workshop config: ${k} is required.`);
  if (!Number.isFinite(Date.parse(c.opensAt)) || !Number.isFinite(Date.parse(c.closesAt)))
    throw new Error("Workshop config: opensAt/closesAt must be ISO timestamps.");
  if (Date.parse(c.closesAt) <= Date.parse(c.opensAt)) throw new Error("Workshop config: closesAt must be after opensAt.");
  for (const k of ["idea", "voteReceived", "built", "uptimeHour"] as const)
    if (typeof c.points?.[k] !== "number" || c.points[k] < 0) throw new Error(`Workshop config: points.${k} must be a non-negative number.`);
  for (const k of ["voteBudget", "voteMaxPerIdea", "ideasPerPlayer", "newAccountDays", "heartbeatIntervalSecs", "heartbeatWindowSecs", "heartbeatSkewSecs"] as const)
    if (typeof (c as any)[k] !== "number" || (c as any)[k] <= 0) throw new Error(`Workshop config: ${k} must be a positive number.`);
  if (typeof c.blockBonus !== "number" || c.blockBonus < 0) throw new Error("Workshop config: blockBonus must be a non-negative number.");
  if (!Number.isInteger(c.workshareCapPerDay) || c.workshareCapPerDay <= 0) throw new Error("Workshop config: workshareCapPerDay must be a positive integer.");
  if (c.rewardAmount !== null && (typeof c.rewardAmount !== "number" || c.rewardAmount < 0))
    throw new Error("Workshop config: rewardAmount must be null or a non-negative dollar amount.");
  if (typeof c.pledge?.text !== "string" || !c.pledge.text) throw new Error("Workshop config: pledge.text is required.");
  if (!["pending", "won", "lost"].includes(c.pledge.prizeOutcome)) throw new Error("Workshop config: pledge.prizeOutcome must be pending, won or lost.");
  const share = c.pledge.nodeOperatorShareOfParticipants;
  if (share !== null && (typeof share !== "number" || share < 0 || share > 1))
    throw new Error("Workshop config: pledge.nodeOperatorShareOfParticipants must be null or a 0–1 fraction.");
  return c;
}
