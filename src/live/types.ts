// A live run: the library plays once, start to finish. Updates from one thread interrupt it:
// freeze -> announce -> react (30 s at most) -> return, then the program resumes where it froze.
// The run's total length is the measurement: library + every second the thread took.

export type UpdateType = "reply" | "quote" | "repost" | "like" | "bookmark" | "views";
export interface Update {
  id: string;
  type: UpdateType;
  at: string; // when it was seen
  user?: string;
  name?: string;
  text?: string;
  url?: string;
  count?: number; // reposts/likes/bookmarks: how many new; views: the milestone passed
}
export interface Line { speaker: "MRS. BUS" | "BORGES" | "AGNOLO" | "LEONARDO"; text: string; audio?: string | null; dur: number; cite?: string }
export interface Script { announce: Line; react: Line[]; returnLine: Line; memory: Array<{ id: string; text: string }> }
export type Phase = "playing" | "freeze" | "announce" | "react" | "return" | "complete";
export interface PhaseSpan { phase: Phase; start: number; end: number } // epoch ms
export interface Interrupt {
  n: number;
  update: Update;
  frozen: { idx: number; offset: number };
  began: number;
  phases: PhaseSpan[]; // empty while the script is being prepared (the freeze holds)
  script: Script | null;
  ended?: number;
}
export interface Program { id: string; title: string; duration: number; media: string; youtube?: string | null }
export interface RunState {
  id: string;
  thread: string;
  library: Program[];
  ident: number;
  startedAt: number;
  phase: Phase;
  idx: number;
  offset: number; // seconds into library[idx] (including its ident tail) at resumedAt
  resumedAt: number;
  current: Interrupt | null;
  queue: Update[];
  done: Array<{ n: number; type: UpdateType; user?: string; began: number; ended: number }>;
  completedAt: number | null;
}
