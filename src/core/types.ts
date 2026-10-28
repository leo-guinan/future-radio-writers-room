// Domain vocabulary for the writers' room.
// Everything that happens is an event; everything you see is a replay of events.

export type Visibility = "public" | "producer";

export interface RoomEvent<T = unknown> {
  seq: number;
  id: string; // ev_000123
  ts: string; // ISO timestamp
  type: EventType;
  actor: string; // "leo", "patron:ada", "borges", "leonardo", "agnolo", "system"
  visibility: Visibility;
  payload: T;
  prev: string; // hash of previous event ("genesis" for first)
  hash: string; // sha256(prev + canonical(event without hash))
}

export type EventType =
  | "room.rules_locked"
  | "idea.proposed"
  | "idea.transitioned"
  | "idea.signal"
  | "idea.note"
  | "agent.run"
  | "episode.planned"
  | "episode.stage"
  | "episode.scene_added"
  | "episode.scene_selected"
  | "episode.asset_added"
  | "episode.released"
  | "budget.authorized"
  | "ledger.entry"
  | "forecast.recorded"
  | "forecast.resolved"
  | "conference.held"
  | "repo.commit"
  | "idea.cut"
  | "showrunner.tick";

// ---------- Ideas: the central unit of the room ----------

export const IDEA_STAGES = ["proposed", "explored", "compared", "selected", "produced", "measured"] as const;
export const IDEA_EXITS = ["deferred", "merged", "declined"] as const;
export type IdeaStage = (typeof IDEA_STAGES)[number];
export type IdeaExit = (typeof IDEA_EXITS)[number];
export type IdeaStatus = IdeaStage | IdeaExit;

export type OutputKind = "scene" | "song" | "episode" | "trailer" | "capability" | "broadcast" | "other";

export interface Contributor {
  name: string; // how they want to be credited
  credit: boolean; // consent to be credited publicly
  reuse: "cc-by" | "show-only" | "ask-first"; // what the show may do with the idea
  contact?: string; // never shown publicly
}

export interface IdeaProposed {
  ideaId: string; // I-0001
  title: string;
  question: string; // the creative question being explored
  output: OutputKind;
  source: string; // what real input inspired it
  contributor: Contributor;
  episodeId?: string;
  estimate?: { cash?: number; hours?: number };
}

export interface IdeaTransitioned {
  ideaId: string;
  from: IdeaStatus;
  to: IdeaStatus;
  reason: string; // why this idea won, lost, merged
  mergedInto?: string;
  result?: string; // when produced/measured: what was made and what was learned
  capability?: string; // reusable capability Marvin or the factory gained
  actual?: { cash?: number; hours?: number };
}

// Three signals that are never summed into one number.
export type SignalKind = "creative" | "community" | "financial";
export interface IdeaSignal {
  ideaId: string;
  kind: SignalKind;
  value: number; // creative: 0-3 judgment, community: +1 per vote, financial: USD actually received
  note?: string;
  receipt?: string; // payment reference for financial signals
}

// ---------- Episodes ----------

export const EPISODE_STAGES = ["planned", "select", "write", "generate", "review", "publish", "account"] as const;
export type EpisodeStage = (typeof EPISODE_STAGES)[number];

export interface EpisodePlanned {
  episodeId: string; // E10
  number: number;
  title: string;
  logline: string;
  canonical: boolean; // part of the ten-episode season vs. companion piece
  budget: { cashCeiling: number; runtimeMinutes: [number, number] };
  deadline?: string;
  round?: number;
}

export interface SceneCandidate {
  sceneId: string; // E10-01
  episodeId: string;
  title: string;
  role: string; // Opening, Frame, Evidence...
  minutes: [number, number];
  summary: string;
  question: string;
  core: boolean;
}

export interface SceneSelected {
  episodeId: string;
  sceneId: string;
  selected: boolean;
  reason: string;
}

export interface AssetAdded {
  episodeId: string;
  kind: "script" | "audio" | "music" | "sfx" | "art" | "notes" | "other";
  label: string;
  uri: string; // path or URL
  sha256?: string;
}

export interface EpisodeReleased {
  episodeId: string;
  version: string; // v1
  uri: string;
  sha256: string;
  scriptSha256?: string;
  runtimeMinutes?: number;
  invitation: string; // what the episode asks the audience to do
}

export interface BudgetAuthorized {
  episodeId: string;
  newCeiling: number;
  reason: string;
}

// ---------- Agnolo's three ledgers ----------

export type LedgerName = "historical" | "operations" | "effort";
export type EvidenceStatus = "observed" | "projected" | "disputed" | "unknown";

export interface LedgerEntry {
  entryId: string;
  ledger: LedgerName;
  kind: "expense" | "receipt" | "hours" | "obligation";
  amount: number;
  unit: "usd" | "hours" | "days" | "tokens";
  status: EvidenceStatus;
  label: string;
  episodeId?: string;
  ideaId?: string;
  evidence?: string; // receipt id, invoice, link
  who?: string; // whose hours
}

export interface ForecastRecorded {
  forecastId: string;
  claim: string;
  metric?: string;
  target?: string;
  dueBy: string;
  source: string;
  verbatim: boolean; // is `claim` the exact original wording?
}

export interface ForecastResolved {
  forecastId: string;
  outcome: "supported" | "failed" | "unresolved";
  observation: string;
  evidence?: string;
}

// ---------- Agents ----------

export type Character = "borges" | "leonardo" | "agnolo" | "showrunner";
export const CAST: Character[] = ["borges", "leonardo", "agnolo"];

export interface AgentRun {
  runId: string;
  character: Character;
  ideaId?: string;
  episodeId?: string;
  askedBy: string;
  prompt: string;
  output: unknown;
  text: string; // what the character said, for the feed
  citations?: string[];
  flags?: string[]; // e.g. "cited unknown event ev_..."
  model: string;
  usage: { input: number; output: number };
  costUsd: number | null; // null = unknown (no prices configured)
  offline: boolean;
}

export interface ConferenceHeld {
  conferenceId: string;
  kind: "opening" | "framing" | "weekly" | "final";
  title: string;
  exhibits: string[]; // event ids put on Agnolo's screen
  notes: string;
}

// ---------- Repos ----------

export interface RepoCommit {
  repo: string; // dressing-room-borges, episode-e02
  sha: string;
  message: string;
  files: string[];
  runId?: string;
  ideaId?: string;
  episodeId?: string;
}

export interface IdeaCut {
  ideaId: string;
  episodeId: string;
  repo: string;
  sha: string;
  path: string; // cuts/I-0008
  approach: string;
  gatesPassed: string[];
  projections: Array<{ character: string; repo: string; sha: string }>;
}

export interface GateResult {
  gate: string;
  pass: boolean;
  why: string;
}

export interface ShowrunnerTick {
  episodeId: string;
  load: number;
  activeGates: string[];
  explored: string[];
  cut: string[];
  held: Array<{ ideaId: string; failed: GateResult[] }>;
  queued: string[]; // ready, but over capacity
  repoSha: string;
}
