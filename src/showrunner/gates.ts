// Quality gates. Each gate is a small, mechanical check. Which gates are on depends on
// load: the more open candidates an episode has, the more gates switch on (gates.json).

import type { Idea, Room } from "../core/room.ts";
import type { GateResult } from "../core/types.ts";
import { nameOf, type Approach, type Evaluation } from "../agents/characters.ts";
import { playedBy } from "../core/cast.ts";

export interface GateConfig {
  gate: string;
  activateAt: number;
  why: string;
  [k: string]: unknown;
}

export interface GatesFile {
  capacity: { maxCutsPerTick: number; maxCutsPerEpisode: number; maxExploresPerTick: number };
  gates: GateConfig[];
}

export interface Candidate {
  idea: Idea;
  approaches: Approach[] | null;
  evaluation: Evaluation | null;
  chosen: Approach | null;
  remaining: number;
  total: number | null; // Agnolo's story + business + participation
}

const tokens = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
export function similarity(a: string, b: string) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

type Check = (c: Candidate, cfg: GateConfig, ctx: { room: Room; cutTexts: Array<{ ideaId: string; text: string }> }) => GateResult;

export const CHECKS: Record<string, Check> = {
  consent: (c, cfg) => {
    if (c.idea.contributor.reuse !== "ask-first") return { gate: cfg.gate, pass: true, why: `reuse: ${c.idea.contributor.reuse}` };
    const ok = c.idea.notes.some((n) => /consent confirmed/i.test(n.text));
    return { gate: cfg.gate, pass: ok, why: ok ? "producer confirmed consent" : "contributor asked to be asked first — add a note 'consent confirmed' once they agree" };
  },
  explored: (c, cfg) => {
    const ok = !!c.approaches?.length && !!c.evaluation;
    return { gate: cfg.gate, pass: ok, why: ok ? "explored by the room" : `waiting for ${nameOf(playedBy("making"))}'s approaches and ${nameOf(playedBy("accounting"))}'s evaluation` };
  },
  "not-declined": (c, cfg) => {
    const rec = c.evaluation?.recommend;
    return { gate: cfg.gate, pass: rec !== "decline", why: `${nameOf(playedBy("accounting"))}: ${rec ?? "no recommendation yet"}` };
  },
  "stopping-rule": (c, cfg) => {
    const ok = !!c.chosen?.stoppingRule?.trim();
    return { gate: cfg.gate, pass: ok, why: ok ? `stop: ${c.chosen!.stoppingRule}` : "no approach with a stopping rule" };
  },
  "budget-fit": (c, cfg) => {
    const est = c.chosen?.estCashUsd;
    const ok = typeof est === "number" && est <= c.remaining + 1e-9;
    return { gate: cfg.gate, pass: ok, why: `~$${est ?? "?"} against $${c.remaining.toFixed(2)} remaining` };
  },
  "agnolo-score": (c, cfg) => {
    const min = Number(cfg.min ?? 5);
    const ok = (c.total ?? -1) >= min;
    return { gate: cfg.gate, pass: ok, why: `scored ${c.total ?? "—"}/9, needs ${min}` };
  },
  signal: (c, cfg) => {
    const s = c.idea.signals;
    const creative = s.creative.length ? s.creative.reduce((a, b) => a + b, 0) / s.creative.length : 0;
    const ok = s.community >= Number(cfg.minCommunity ?? 1) || creative >= Number(cfg.minCreative ?? 2);
    return { gate: cfg.gate, pass: ok, why: `${s.community} vote(s), creative ${s.creative.length ? creative.toFixed(1) : "—"}` };
  },
  novelty: (c, cfg, ctx) => {
    const max = Number(cfg.maxSimilarity ?? 0.5);
    const text = `${c.idea.title} ${c.idea.question}`;
    let best = { ideaId: "", sim: 0 };
    for (const o of ctx.cutTexts) {
      if (o.ideaId === c.idea.ideaId) continue;
      const sim = similarity(text, o.text);
      if (sim > best.sim) best = { ideaId: o.ideaId, sim };
    }
    const ok = best.sim < max;
    return { gate: cfg.gate, pass: ok, why: ok ? `closest cut ${best.ideaId || "none"} at ${best.sim.toFixed(2)}` : `too close to ${best.ideaId} (${best.sim.toFixed(2)}) — consider merging` };
  },
  "producer-approval": (c, cfg) => {
    const ok = c.idea.signals.creative.length > 0;
    return { gate: cfg.gate, pass: ok, why: ok ? "producer has judged it" : "waiting for the producer's creative signal" };
  },
};

export function activeGates(file: GatesFile, load: number): GateConfig[] {
  return file.gates.filter((g) => load >= g.activateAt && CHECKS[g.gate]);
}

// These only mean something once Leonardo and Agnolo have worked on the idea.
const NEEDS_EXPLORATION = new Set(["not-declined", "stopping-rule", "budget-fit", "agnolo-score"]);

export function evaluate(c: Candidate, gates: GateConfig[], ctx: Parameters<Check>[2]): GateResult[] {
  const explored = !!c.approaches?.length && !!c.evaluation;
  return gates.filter((g) => explored || !NEEDS_EXPLORATION.has(g.gate)).map((g) => CHECKS[g.gate](c, g, ctx));
}
