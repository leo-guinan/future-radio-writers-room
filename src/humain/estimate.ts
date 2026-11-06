// Estimates: spend, local effort, execution time. Every figure is labeled
// ESTIMATE and booked as a forecast plus projected ledger entries — never as a
// receipt. Actuals land on the same ledgers as observed entries with evidence.

import type { Room } from "../core/room.ts";
import type { HumainPlan } from "../core/types.ts";

export interface Estimate {
  apiUsd: number;
  localHours: number;
  executionSeconds: number;
}

export function estimatePlan(plan: HumainPlan): Estimate {
  const apiUsd = plan.tasks.reduce((s, t) => s + t.estApiUsd, 0);
  const localHours = plan.tasks.reduce((s, t) => s + t.estHours, 0);
  const executionSeconds = plan.tasks.reduce((s, t) => s + t.estSeconds, 0);
  return {
    apiUsd: Math.round(apiUsd * 10000) / 10000,
    localHours: Math.round(localHours * 100) / 100,
    executionSeconds,
  };
}

/** Book the estimate where the room keeps forecasts: a forecast + projected entries. */
export function bookEstimate(room: Room, actor: string, sessionId: string, est: Estimate): string {
  const ev = room.recordForecast(
    actor,
    {
      claim: `ESTIMATE: session ${sessionId} will cost ~$${est.apiUsd.toFixed(2)} API, ~${est.localHours}h local effort, ~${est.executionSeconds}s execution.`,
      metric: "api_usd,local_hours,execution_seconds",
      target: `${est.apiUsd},${est.localHours},${est.executionSeconds}`,
      dueBy: new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10),
      source: `humain session ${sessionId}`,
      verbatim: true,
    },
    "public",
  );
  const forecastId = (ev.payload as { forecastId: string }).forecastId;
  room.addLedgerEntry(
    actor,
    { ledger: "operations", kind: "expense", amount: est.apiUsd, unit: "usd", status: "projected", label: `ESTIMATE ${sessionId} API spend`, evidence: ev.id },
    "producer",
  );
  room.addLedgerEntry(
    actor,
    { ledger: "effort", kind: "hours", amount: est.localHours, unit: "hours", status: "projected", label: `ESTIMATE ${sessionId} local effort`, who: actor },
    "producer",
  );
  return forecastId;
}

/** Resolve the estimate forecast against measured actuals. Forecasts aren't receipts. */
export function resolveEstimate(room: Room, actor: string, forecastId: string, actual: Estimate): void {
  const f = room.forecasts.get(forecastId);
  if (!f || f.resolution) return;
  const [eApi, eHours, eSecs] = (f.target ?? "0,0,0").split(",").map(Number);
  const close = (e: number, a: number) => (e === 0 ? a === 0 : Math.abs(e - a) / Math.max(e, 1e-9) <= 0.5);
  const supported = close(eApi, actual.apiUsd) && close(eHours, actual.localHours) && close(eSecs, actual.executionSeconds);
  room.resolveForecast(actor, {
    forecastId,
    outcome: supported ? "supported" : "failed",
    observation: `Actual: $${actual.apiUsd.toFixed(2)} API, ${actual.localHours}h, ${actual.executionSeconds}s vs estimate $${eApi}, ${eHours}h, ${eSecs}s.`,
    evidence: `humain session ledger`,
  });
}
