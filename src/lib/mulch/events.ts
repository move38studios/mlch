/** What the server streams to an open mulch window (GET /api/mulches/:id/events). */

import type { Mulch, OpBatch } from "./types";

export interface TranscriptSegment {
  id: string;
  /** ms epoch when the chunk was recorded. */
  at: number;
  text: string;
  /** "speech" (transcribed) or "typed". */
  source: "speech" | "typed";
  /** In a call: the microphone ("me") or the Mac's sound output ("them"). */
  speaker?: "me" | "them";
}

/** Capture, enrichment, quick instructions, reading drops, and long work (making, research). */
export type JobLane = "fast" | "slow" | "command" | "ingest" | "long";

/** What a job was asked to do, so it can be started again. */
export interface JobRetry {
  kind: "command" | "make" | "research" | "folder" | "callNotes";
  input: string;
  near?: string[];
  title?: string;
}

export interface JobStatus {
  id: string;
  lane: JobLane;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  /** One short line ("Adding ideas", "Deck: cities and forests"). */
  label: string;
  error?: string;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  /** What it is doing now ("Writing slides.py"). */
  activity?: string;
  /** Items it added. */
  resultIds?: string[];
  /** The speech or typing it came from (transcript segment ids): the conversation shows what became of each. */
  inputIds?: string[];
  /** Finished (done or failed) and not yet seen by the person. */
  unseen?: boolean;
  /** Set for the person's instructions and long work: these are kept in jobs.json and can be retried. */
  retry?: JobRetry;
  /** A message from the AI to the person (`tell`), shown until they close it. */
  message?: { text: string; at: number; dismissed?: boolean };
  /** Long work: the space held on the canvas for its result. */
  anchor?: { x: number; y: number; w: number; h: number };
}

/** Kept jobs that count for the mulch list and the Dock badge. */
export function jobActivity(jobs: Iterable<JobStatus>): { working: number; unseen: number; failed: number } {
  let working = 0;
  let unseen = 0;
  let failed = 0;
  for (const job of jobs) {
    if (!job.retry) continue;
    if (job.state === "queued" || job.state === "running") working++;
    else if (job.unseen && job.state === "done") unseen++;
    else if (job.unseen && job.state === "failed") failed++;
  }
  return { working, unseen, failed };
}

export type ServerEvent =
  /** Sent first on every connection: the whole mulch as it is now. */
  | { type: "snapshot"; mulch: Mulch; transcript: TranscriptSegment[]; jobs: JobStatus[]; paused: boolean }
  | { type: "ops"; batch: OpBatch }
  | { type: "transcript"; segment: TranscriptSegment }
  | { type: "job"; job: JobStatus }
  /** Enrichment paused or resumed. */
  | { type: "paused"; paused: boolean }
  /** A short status line from the agent (its `reply` tool). */
  | { type: "say"; text: string; jobId: string }
  | { type: "notice"; level: "error" | "info"; message: string }
  /** The agent shows items: pan to them, highlight; open a document at a page or quote. */
  | { type: "focus"; ids: string[]; page?: number; quote?: string }
  /** The agent moves the view: show everything, or zoom a step in or out. */
  | { type: "view"; action: ViewAction };

export type ViewAction = "fit" | "in" | "out";
