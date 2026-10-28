// The room: replays the event log into state and enforces the rules of the experiment.
//
// Locked rules (from the Artup Production Plan, Oct 27 2026):
//   1. Forecasts aren't receipts. Projected money never counts as observed.
//   2. Founder hours aren't free. They're recorded, even when they cost no cash.
//   3. Old investment is not automatically a November expense (separate ledger).
//   4. A released cut is immutable. Later work may respond to it, never rewrite it.
//   5. Exceeding an episode's cash ceiling requires an explicit authorization event.
//   6. Creative judgment, community interest and financial support stay separate signals.

import { EventStore, sha256 } from "./events.ts";
import { playedBy } from "./cast.ts";
import {
  EPISODE_STAGES,
  IDEA_EXITS,
  IDEA_STAGES,
  type AgentRun,
  type AssetAdded,
  type BudgetAuthorized,
  type ConferenceHeld,
  type EpisodePlanned,
  type EpisodeReleased,
  type EpisodeStage,
  type ForecastRecorded,
  type ForecastResolved,
  type IdeaProposed,
  type IdeaSignal,
  type IdeaCut,
  type IdeaStatus,
  type ShowrunnerTick,
  type SceneOpened,
  type SceneTurn,
  type SceneClosed,
  type SceneVoiced,
  type IdeaTransitioned,
  type LedgerEntry,
  type RoomEvent,
  type SceneCandidate,
  type SceneSelected,
  type Visibility,
} from "./types.ts";

export class RuleError extends Error {
  constructor(readonly rule: string, message: string) {
    super(message);
  }
}

export const LOCKED_RULES = [
  "Forecasts aren't receipts: projected money never counts as observed.",
  "Founder hours aren't free: human effort is recorded even when it costs no cash.",
  "Old investment is not automatically a November expense: historical spend lives in its own ledger.",
  "A released cut is immutable: later work may respond to it, never rewrite it.",
  "Exceeding an episode's cash ceiling requires an explicit, recorded authorization.",
  "Creative judgment, community interest and financial support are separate signals and are never summed.",
];

export interface Idea extends IdeaProposed {
  status: IdeaStatus;
  proposedAt: string;
  proposedBy: string;
  history: Array<IdeaTransitioned & { at: string; by: string; eventId: string }>;
  signals: { creative: number[]; community: number; financial: number };
  runs: string[];
  notes: Array<{ at: string; by: string; text: string }>;
  eventId: string;
}

export interface Episode extends EpisodePlanned {
  stage: EpisodeStage;
  stageHistory: Array<{ stage: EpisodeStage; at: string; by: string; note?: string }>;
  scenes: Map<string, SceneCandidate & { selected: boolean | null; reason?: string }>;
  assets: Array<AssetAdded & { at: string }>;
  releases: Array<EpisodeReleased & { at: string; eventId: string }>;
  ceiling: number;
  authorizations: Array<BudgetAuthorized & { at: string; by: string }>;
}

export interface Forecast extends ForecastRecorded {
  recordedAt: string;
  eventId: string;
  resolution?: ForecastResolved & { at: string };
}

const nextIdeaStage = (s: IdeaStatus): number => IDEA_STAGES.indexOf(s as (typeof IDEA_STAGES)[number]);
const isExit = (s: IdeaStatus) => (IDEA_EXITS as readonly string[]).includes(s);

export interface Scene extends SceneOpened {
  openedAt: string;
  openedBy: string;
  motivations: Record<string, string>;
  turns: Array<SceneTurn & { at: string; eventId: string }>;
  voiced: Record<number, SceneVoiced & { at: string }>;
  closed: (SceneClosed & { at: string }) | null;
}

export class Room {
  ideas = new Map<string, Idea>();
  episodes = new Map<string, Episode>();
  ledger: Array<LedgerEntry & { at: string; by: string; eventId: string }> = [];
  forecasts = new Map<string, Forecast>();
  runs = new Map<string, AgentRun & { at: string; eventId: string }>();
  conferences: Array<ConferenceHeld & { at: string }> = [];
  cuts: Array<IdeaCut & { at: string; eventId: string }> = [];
  ticks: Array<ShowrunnerTick & { at: string; eventId: string }> = [];
  scenes = new Map<string, Scene>();
  rulesLocked = false;

  constructor(readonly store: EventStore) {
    for (const e of store.all()) this.apply(e);
    store.subscribe((e) => this.apply(e));
  }

  // ---------------- replay ----------------

  private apply(e: RoomEvent): void {
    const p = e.payload as any;
    switch (e.type) {
      case "room.rules_locked":
        this.rulesLocked = true;
        break;
      case "idea.proposed":
        this.ideas.set(p.ideaId, {
          ...(p as IdeaProposed),
          status: "proposed",
          proposedAt: e.ts,
          proposedBy: e.actor,
          history: [],
          signals: { creative: [], community: 0, financial: 0 },
          runs: [],
          notes: [],
          eventId: e.id,
        });
        break;
      case "idea.transitioned": {
        const idea = this.ideas.get(p.ideaId)!;
        idea.status = p.to;
        idea.history.push({ ...(p as IdeaTransitioned), at: e.ts, by: e.actor, eventId: e.id });
        break;
      }
      case "idea.signal": {
        const idea = this.ideas.get(p.ideaId)!;
        const s = p as IdeaSignal;
        if (s.kind === "creative") idea.signals.creative.push(s.value);
        if (s.kind === "community") idea.signals.community += s.value;
        if (s.kind === "financial") idea.signals.financial += s.value;
        break;
      }
      case "idea.note":
        this.ideas.get(p.ideaId)?.notes.push({ at: e.ts, by: e.actor, text: p.text });
        break;
      case "agent.run": {
        const run = p as AgentRun;
        this.runs.set(run.runId, { ...run, at: e.ts, eventId: e.id });
        if (run.ideaId) this.ideas.get(run.ideaId)?.runs.push(run.runId);
        break;
      }
      case "episode.planned":
        this.episodes.set(p.episodeId, {
          ...(p as EpisodePlanned),
          stage: "planned",
          stageHistory: [{ stage: "planned", at: e.ts, by: e.actor }],
          scenes: new Map(),
          assets: [],
          releases: [],
          ceiling: p.budget.cashCeiling,
          authorizations: [],
        });
        break;
      case "episode.stage": {
        const ep = this.episodes.get(p.episodeId)!;
        ep.stage = p.stage;
        ep.stageHistory.push({ stage: p.stage, at: e.ts, by: e.actor, note: p.note });
        break;
      }
      case "episode.scene_added":
        this.episodes.get(p.episodeId)!.scenes.set(p.sceneId, { ...(p as SceneCandidate), selected: null });
        break;
      case "episode.scene_selected": {
        const sc = this.episodes.get(p.episodeId)!.scenes.get(p.sceneId)!;
        sc.selected = p.selected;
        sc.reason = p.reason;
        break;
      }
      case "episode.asset_added":
        this.episodes.get(p.episodeId)!.assets.push({ ...(p as AssetAdded), at: e.ts });
        break;
      case "episode.released":
        this.episodes.get(p.episodeId)!.releases.push({ ...(p as EpisodeReleased), at: e.ts, eventId: e.id });
        break;
      case "budget.authorized": {
        const ep = this.episodes.get(p.episodeId)!;
        ep.ceiling = p.newCeiling;
        ep.authorizations.push({ ...(p as BudgetAuthorized), at: e.ts, by: e.actor });
        break;
      }
      case "ledger.entry":
        this.ledger.push({ ...(p as LedgerEntry), at: e.ts, by: e.actor, eventId: e.id });
        break;
      case "forecast.recorded":
        this.forecasts.set(p.forecastId, { ...(p as ForecastRecorded), recordedAt: e.ts, eventId: e.id });
        break;
      case "forecast.resolved":
        this.forecasts.get(p.forecastId)!.resolution = { ...(p as ForecastResolved), at: e.ts };
        break;
      case "conference.held":
        this.conferences.push({ ...(p as ConferenceHeld), at: e.ts });
        break;
      case "idea.cut":
        this.cuts.push({ ...(p as IdeaCut), at: e.ts, eventId: e.id });
        break;
      case "showrunner.tick":
        this.ticks.push({ ...(p as ShowrunnerTick), at: e.ts, eventId: e.id });
        break;
      case "scene.opened":
        this.scenes.set(p.sceneId, { ...(p as SceneOpened), openedAt: e.ts, openedBy: e.actor, motivations: {}, turns: [], voiced: {}, closed: null });
        break;
      case "scene.motivation":
        this.scenes.get(p.sceneId)!.motivations[p.character] = p.motivation;
        break;
      case "scene.turn":
        this.scenes.get(p.sceneId)!.turns.push({ ...(p as SceneTurn), at: e.ts, eventId: e.id });
        break;
      case "scene.closed":
        this.scenes.get(p.sceneId)!.closed = { ...(p as SceneClosed), at: e.ts };
        break;
      case "scene.voiced":
        this.scenes.get(p.sceneId)!.voiced[p.n] = { ...(p as SceneVoiced), at: e.ts };
        break;
    }
  }

  // ---------------- commands ----------------

  lockRules(actor: string, ts?: string) {
    if (this.rulesLocked) throw new RuleError("rules", "Rules are already locked.");
    return this.store.append("room.rules_locked", actor, { rules: LOCKED_RULES }, "public", ts);
  }

  proposeIdea(actor: string, input: Omit<IdeaProposed, "ideaId">, ts?: string) {
    if (!input.title?.trim()) throw new RuleError("idea", "An idea needs a title.");
    if (!input.question?.trim()) throw new RuleError("idea", "An idea needs a creative question: what is being explored?");
    if (!input.source?.trim()) throw new RuleError("idea", "An idea needs a source: what real input inspired it?");
    if (!input.contributor?.name?.trim()) throw new RuleError("consent", "A contributor name is required.");
    if (!["cc-by", "show-only", "ask-first"].includes(input.contributor.reuse))
      throw new RuleError("consent", "Choose how the show may reuse the idea.");
    if (input.episodeId && !this.episodes.has(input.episodeId)) throw new RuleError("idea", `Unknown episode ${input.episodeId}.`);
    const ideaId = `I-${String(this.ideas.size + 1).padStart(4, "0")}`;
    return this.store.append("idea.proposed", actor, { ...input, ideaId }, "public", ts);
  }

  transitionIdea(actor: string, t: Omit<IdeaTransitioned, "from">, ts?: string) {
    const idea = this.mustIdea(t.ideaId);
    const from = idea.status;
    const to = t.to;
    if (!t.reason?.trim()) throw new RuleError("selection", "Every decision records a reason.");
    if (from === to) throw new RuleError("lifecycle", `${idea.ideaId} is already ${to}.`);
    if (from === "measured" || from === "merged" || from === "declined")
      throw new RuleError("lifecycle", `${idea.ideaId} is ${from}; that outcome stays in the archive. Propose a new idea instead.`);
    if (from === "deferred") {
      if (to !== "proposed" && !isExit(to))
        throw new RuleError("lifecycle", "A deferred idea returns to 'proposed' before moving again.");
    } else if (!isExit(to)) {
      const a = nextIdeaStage(from);
      const b = nextIdeaStage(to);
      if (b <= a) throw new RuleError("lifecycle", `Ideas move forward (${from} → ${to} is backwards). Defer it instead.`);
    }
    if (to === "merged" && !t.mergedInto) throw new RuleError("lifecycle", "A merge names the idea it merges into.");
    if (t.mergedInto) this.mustIdea(t.mergedInto);
    if ((to === "produced" || to === "measured") && !t.result)
      throw new RuleError("lifecycle", `Moving to ${to} requires a result: what was made and what was learned.`);
    if (to === "measured" && !t.actual) throw new RuleError("lifecycle", "Measuring requires actual cash and hours.");
    return this.store.append("idea.transitioned", actor, { ...t, from }, "public", ts);
  }

  signal(actor: string, s: IdeaSignal, ts?: string) {
    this.mustIdea(s.ideaId);
    if (s.kind === "financial" && !s.receipt)
      throw new RuleError("receipts", "Financial support is recorded only with a receipt. Pledges are forecasts, not receipts.");
    if (s.kind === "creative" && (s.value < 0 || s.value > 3)) throw new RuleError("signal", "Creative judgment is 0–3.");
    if (s.value < 0) throw new RuleError("signal", "Signals are non-negative.");
    return this.store.append("idea.signal", actor, s, s.kind === "financial" ? "producer" : "public", ts);
  }

  note(actor: string, ideaId: string, text: string, visibility: Visibility = "public") {
    this.mustIdea(ideaId);
    return this.store.append("idea.note", actor, { ideaId, text }, visibility);
  }

  planEpisode(actor: string, ep: EpisodePlanned, ts?: string) {
    if (this.episodes.has(ep.episodeId)) throw new RuleError("episode", `${ep.episodeId} already exists.`);
    if (!(ep.budget?.cashCeiling >= 0)) throw new RuleError("budget", "An episode needs an explicit cash ceiling.");
    return this.store.append("episode.planned", actor, ep, "public", ts);
  }

  advanceEpisode(actor: string, episodeId: string, stage: EpisodeStage, note?: string, ts?: string) {
    const ep = this.mustEpisode(episodeId);
    const a = EPISODE_STAGES.indexOf(ep.stage);
    const b = EPISODE_STAGES.indexOf(stage);
    if (b !== a + 1) throw new RuleError("production", `${episodeId} is at '${ep.stage}'; the next stage is '${EPISODE_STAGES[a + 1] ?? "none"}'.`);
    if (stage === "account" && ep.releases.length === 0)
      throw new RuleError("production", "Publish a release before accounting for it.");
    if (stage === "write" && ![...ep.scenes.values()].some((s) => s.selected) && ep.scenes.size > 0)
      throw new RuleError("production", "Select at least one scene before writing.");
    return this.store.append("episode.stage", actor, { episodeId, stage, note }, "public", ts);
  }

  addScene(actor: string, sc: SceneCandidate, ts?: string) {
    const ep = this.mustEpisode(sc.episodeId);
    this.assertUnreleased(ep);
    if (ep.scenes.has(sc.sceneId)) throw new RuleError("episode", `${sc.sceneId} already exists.`);
    return this.store.append("episode.scene_added", actor, sc, "public", ts);
  }

  selectScene(actor: string, s: SceneSelected, ts?: string) {
    const ep = this.mustEpisode(s.episodeId);
    this.assertUnreleased(ep);
    if (!ep.scenes.has(s.sceneId)) throw new RuleError("episode", `Unknown scene ${s.sceneId}.`);
    if (!s.reason?.trim()) throw new RuleError("selection", "Every selection decision records a reason.");
    return this.store.append("episode.scene_selected", actor, s, "public", ts);
  }

  addAsset(actor: string, a: AssetAdded, visibility: Visibility = "public") {
    const ep = this.mustEpisode(a.episodeId);
    this.assertUnreleased(ep);
    return this.store.append("episode.asset_added", actor, a, visibility);
  }

  release(actor: string, r: EpisodeReleased, ts?: string) {
    const ep = this.mustEpisode(r.episodeId);
    if (ep.stage !== "publish") throw new RuleError("production", `Advance ${r.episodeId} to 'publish' before releasing (now '${ep.stage}').`);
    if (ep.releases.some((x) => x.version === r.version))
      throw new RuleError("immutable", `${r.episodeId} ${r.version} is already released and locked. Release a new version instead.`);
    if (!/^[0-9a-f]{64}$/.test(r.sha256)) throw new RuleError("immutable", "A release records the sha256 of the released file.");
    if (!r.invitation?.trim()) throw new RuleError("participation", "Every release invites a specific response.");
    return this.store.append("episode.released", actor, r, "public", ts);
  }

  authorizeBudget(actor: string, b: BudgetAuthorized) {
    const ep = this.mustEpisode(b.episodeId);
    if (b.newCeiling <= ep.ceiling) throw new RuleError("budget", "An authorization raises the ceiling; it can't lower history.");
    if (!b.reason?.trim()) throw new RuleError("budget", "Raising the ceiling requires a stated reason.");
    return this.store.append("budget.authorized", actor, b, "public");
  }

  addLedgerEntry(actor: string, input: Omit<LedgerEntry, "entryId">, visibility: Visibility = "producer", ts?: string) {
    if (input.amount < 0) throw new RuleError("ledger", "Amounts are non-negative; the kind says which direction money moved.");
    if (input.kind === "receipt" && input.status === "observed" && !input.evidence)
      throw new RuleError("receipts", "An observed receipt needs evidence (payment id, invoice, link).");
    if (input.kind === "hours" && input.unit !== "hours" && input.unit !== "days") throw new RuleError("ledger", "Time is recorded in hours or days.");
    if (input.kind === "hours" && input.ledger !== "effort") throw new RuleError("ledger", "Hours belong to the effort ledger.");
    if (input.ledger === "operations" && input.kind === "expense" && input.unit === "usd" && input.status === "observed" && input.episodeId) {
      const ep = this.mustEpisode(input.episodeId);
      const spent = this.episodeCash(ep.episodeId);
      if (spent + input.amount > ep.ceiling + 1e-9)
        throw new RuleError(
          "budget",
          `${ep.episodeId} would spend $${(spent + input.amount).toFixed(2)} against a $${ep.ceiling.toFixed(2)} ceiling. Simplify, or authorize a larger budget first.`,
        );
    }
    const entryId = `L-${String(this.ledger.length + 1).padStart(4, "0")}`;
    return this.store.append("ledger.entry", actor, { ...input, entryId }, visibility, ts);
  }

  recordForecast(actor: string, f: Omit<ForecastRecorded, "forecastId">, visibility: Visibility = "public", ts?: string) {
    const forecastId = `F-${String(this.forecasts.size + 1).padStart(3, "0")}`;
    return this.store.append("forecast.recorded", actor, { ...f, forecastId }, visibility, ts);
  }

  resolveForecast(actor: string, r: ForecastResolved) {
    const f = this.forecasts.get(r.forecastId);
    if (!f) throw new RuleError("forecast", `Unknown forecast ${r.forecastId}.`);
    if (f.resolution) throw new RuleError("immutable", `${r.forecastId} was already resolved as '${f.resolution.outcome}'.`);
    const ev = this.store.all().find((e) => e.id === f.eventId)!;
    return this.store.append("forecast.resolved", actor, r, ev.visibility);
  }

  recordRun(run: AgentRun, visibility: Visibility = "public") {
    const ev = this.store.append("agent.run", run.character, run, visibility);
    // Compute is a real operating cost. Unknown prices are recorded as unknown, not zero.
    this.store.append(
      "ledger.entry",
      playedBy("accounting"),
      {
        entryId: `L-${String(this.ledger.length + 1).padStart(4, "0")}`,
        ledger: "operations",
        kind: "expense",
        amount: run.costUsd ?? run.usage.input + run.usage.output,
        unit: run.costUsd === null ? "tokens" : "usd",
        status: run.costUsd === null ? "unknown" : "observed",
        label: `${run.character} run ${run.runId}${run.offline ? " (offline)" : ""}`,
        episodeId: run.episodeId,
        ideaId: run.ideaId,
        evidence: ev.id,
      } satisfies LedgerEntry,
      "producer",
    );
    return ev;
  }

  holdConference(actor: string, c: Omit<ConferenceHeld, "conferenceId">) {
    for (const x of c.exhibits) if (!this.store.all().some((e) => e.id === x)) throw new RuleError("exhibit", `No event ${x} to exhibit.`);
    const conferenceId = `C-${String(this.conferences.length + 1).padStart(3, "0")}`;
    return this.store.append("conference.held", actor, { ...c, conferenceId }, "public");
  }

  // ---------------- queries ----------------

  mustIdea(id: string): Idea {
    const i = this.ideas.get(id);
    if (!i) throw new RuleError("idea", `Unknown idea ${id}.`);
    return i;
  }

  mustEpisode(id: string): Episode {
    const e = this.episodes.get(id);
    if (!e) throw new RuleError("episode", `Unknown episode ${id}.`);
    return e;
  }

  private assertUnreleased(ep: Episode) {
    if (ep.releases.length > 0)
      throw new RuleError("immutable", `${ep.episodeId} has a released cut. It is a fixed reference; respond to it in a new idea or episode.`);
  }

  episodeCash(episodeId: string): number {
    return this.ledger
      .filter((l) => l.episodeId === episodeId && l.ledger === "operations" && l.kind === "expense" && l.unit === "usd" && l.status === "observed")
      .reduce((s, l) => s + l.amount, 0);
  }

  episodeHours(episodeId: string): number {
    return this.ledger.filter((l) => l.episodeId === episodeId && l.kind === "hours" && l.unit === "hours").reduce((s, l) => s + l.amount, 0);
  }

  episodeDays(episodeId: string): number {
    return this.ledger.filter((l) => l.episodeId === episodeId && l.kind === "hours" && l.unit === "days").reduce((s, l) => s + l.amount, 0);
  }

  /** Agnolo's screen. Observed, projected, disputed and unknown never blend. */
  scorecard() {
    const sum = (f: (l: LedgerEntry) => boolean) => this.ledger.filter(f).reduce((s, l) => s + l.amount, 0);
    const usd = (l: LedgerEntry) => l.unit === "usd";
    const byStatus = (status: string) => ({
      receipts: sum((l) => l.ledger === "operations" && usd(l) && l.kind === "receipt" && l.status === status),
      expenses: sum((l) => l.ledger === "operations" && usd(l) && l.kind === "expense" && l.status === status),
    });
    const observed = byStatus("observed");
    const hoursBy: Record<string, number> = {};
    const daysBy: Record<string, number> = {};
    for (const l of this.ledger.filter((l) => l.kind === "hours")) {
      const bucket = l.unit === "days" ? daysBy : hoursBy;
      bucket[l.who ?? "unknown"] = (bucket[l.who ?? "unknown"] ?? 0) + l.amount;
    }
    return {
      operations: {
        observed: { ...observed, contribution: observed.receipts - observed.expenses },
        projected: byStatus("projected"),
        disputed: byStatus("disputed"),
        unknownItems: this.ledger.filter((l) => l.status === "unknown").length,
        unpricedTokens: sum((l) => l.unit === "tokens" && l.status !== "observed"),
      },
      historical: { expenses: sum((l) => l.ledger === "historical" && usd(l) && l.kind === "expense") },
      effort: {
        hoursBy,
        daysBy,
        obligations: this.ledger.filter((l) => l.kind === "obligation").map((l) => ({ label: l.label, amount: l.amount, unit: l.unit, status: l.status })),
      },
      episodes: [...this.episodes.values()].map((e) => ({
        episodeId: e.episodeId,
        title: e.title,
        stage: e.stage,
        ceiling: e.ceiling,
        cash: this.episodeCash(e.episodeId),
        hours: this.episodeHours(e.episodeId),
        days: this.episodeDays(e.episodeId),
        released: e.releases.map((r) => r.version),
      })),
      forecasts: [...this.forecasts.values()].map((f) => ({ id: f.forecastId, claim: f.claim, dueBy: f.dueBy, outcome: f.resolution?.outcome ?? "open" })),
    };
  }

  /** Signals side by side, never summed. */
  board() {
    return [...this.ideas.values()].map((i) => ({
      ideaId: i.ideaId,
      title: i.title,
      status: i.status,
      output: i.output,
      episodeId: i.episodeId,
      creative: i.signals.creative.length ? i.signals.creative.reduce((a, b) => a + b, 0) / i.signals.creative.length : null,
      community: i.signals.community,
      financial: i.signals.financial,
      runs: i.runs.length,
    }));
  }

  /** What patrons see: public events only, contact details removed. */
  // ---------------- scenes ----------------

  /** Open a scene. Each character's motivation is recorded privately; the card is public. */
  openScene(actor: string, card: Omit<SceneOpened, "sceneId" | "maxTurns" | "revealMotivations" | "cast"> & { maxTurns?: number; revealMotivations?: boolean }, cast: Array<{ character: string; motivation: string }>) {
    for (const k of ["title", "setting", "situation", "stakes", "stoppingRule"] as const)
      if (!String(card[k] ?? "").trim()) throw new RuleError("scene", `A scene needs a ${k === "stoppingRule" ? "stopping rule: when is it over?" : k}.`);
    if (cast.length < 2) throw new RuleError("scene", "A scene needs at least two characters.");
    if (new Set(cast.map((c) => c.character)).size !== cast.length) throw new RuleError("scene", "Each character appears once in the cast.");
    for (const c of cast) if (!c.motivation?.trim()) throw new RuleError("scene", `${c.character} needs a motivation: what do they want in this scene?`);
    const maxTurns = card.maxTurns ?? 12;
    if (!(maxTurns >= 2 && maxTurns <= 40)) throw new RuleError("scene", "maxTurns is between 2 and 40.");
    if (card.episodeId && !this.episodes.has(card.episodeId)) throw new RuleError("episode", `Unknown episode ${card.episodeId}.`);
    if (card.ideaId && !this.ideas.has(card.ideaId)) throw new RuleError("idea", `Unknown idea ${card.ideaId}.`);
    const sceneId = `S-${String(this.scenes.size + 1).padStart(4, "0")}`;
    const opened: SceneOpened = {
      sceneId,
      title: card.title.trim(),
      setting: card.setting.trim(),
      situation: card.situation.trim(),
      stakes: card.stakes.trim(),
      stoppingRule: card.stoppingRule.trim(),
      maxTurns,
      cast: cast.map((c) => c.character),
      episodeId: card.episodeId,
      ideaId: card.ideaId,
      revealMotivations: card.revealMotivations ?? true,
    };
    const ev = this.store.append("scene.opened", actor, opened, "public");
    for (const c of cast) this.store.append("scene.motivation", actor, { sceneId, character: c.character, motivation: c.motivation.trim() }, "producer");
    return ev;
  }

  mustScene(sceneId: string): Scene {
    const s = this.scenes.get(sceneId);
    if (!s) throw new RuleError("scene", `No scene ${sceneId}.`);
    return s;
  }

  recordSceneTurn(actor: string, t: Omit<SceneTurn, "n">) {
    const s = this.mustScene(t.sceneId);
    if (s.closed) throw new RuleError("scene", `${s.sceneId} is closed. Open a new scene to play it again.`);
    if (!s.cast.includes(t.character)) throw new RuleError("scene", `${t.character} isn't in ${s.sceneId}.`);
    if (s.turns.length >= s.maxTurns) throw new RuleError("scene", `${s.sceneId} has used all ${s.maxTurns} turns.`);
    return this.store.append("scene.turn", actor, { ...t, n: s.turns.length + 1 }, "public");
  }

  closeScene(actor: string, sceneId: string, reason: string, repo?: SceneClosed["repo"]) {
    const s = this.mustScene(sceneId);
    if (s.closed) throw new RuleError("scene", `${sceneId} is already closed.`);
    const closed: SceneClosed = { sceneId, reason, turns: s.turns.length, repo, ...(s.revealMotivations ? { motivations: { ...s.motivations } } : {}) };
    return this.store.append("scene.closed", actor, closed, "public");
  }

  recordSceneVoice(actor: string, v: SceneVoiced) {
    const s = this.mustScene(v.sceneId);
    if (!s.turns.some((t) => t.n === v.n)) throw new RuleError("scene", `${v.sceneId} has no line ${v.n}.`);
    return this.store.append("scene.voiced", actor, v, "public");
  }

  publicEvents(sinceSeq = 0): RoomEvent[] {
    return this.store
      .all()
      .filter((e) => e.visibility === "public" && e.seq > sinceSeq)
      .map((e) => (e.type === "idea.proposed" ? redactContributor(e) : e));
  }
}

function redactContributor(e: RoomEvent): RoomEvent {
  const p = e.payload as IdeaProposed;
  const { contact: _c, ...contributor } = p.contributor;
  const shown = contributor.credit ? contributor : { ...contributor, name: "anonymous patron" };
  return { ...e, payload: { ...p, contributor: shown } };
}

export { sha256 };
