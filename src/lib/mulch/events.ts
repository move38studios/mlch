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
  kind: "command" | "make" | "research" | "folder" | "callNotes" | "callTidy";
  input: string;
  near?: string[];
  title?: string;
  /** A comment acted on by itself ("do it now"): not the person's turn, nothing else goes with it. */
  comment?: string;
}

export interface JobStatus {
  id: string;
  lane: JobLane;
  /** paused: its time period ran out; what it added stays and "keep going" resumes it (`session`). */
  state: "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
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
  /**
   * Connector tools that act, waiting for the person's Allow or Deny. Server and
   * tool names come from the person's config: untrusted text.
   */
  approvals?: Array<{ id: string; server: string; tool: string; input: Record<string, string>; at: number }>;
  /** The vendor session its last turn ran in, so a paused job can resume it. */
  session?: { id: string; harness: string };
  /** Long work: the space held on the canvas for its result. */
  anchor?: { x: number; y: number; w: number; h: number };
}

export interface JobActivity {
  working: number;
  unseen: number;
  failed: number;
  /** Paused (time ran out), waiting for "keep going". */
  paused?: number;
  /** A connector card waiting for Allow or Deny. */
  waiting?: number;
  /** When the person's work last ran or finished. */
  lastAt?: number;
}

/** Kept jobs that count for the mulch list, the list of other mulches and the Dock badge. */
export function jobActivity(jobs: Iterable<JobStatus>): JobActivity {
  let working = 0;
  let unseen = 0;
  let failed = 0;
  let paused = 0;
  let waiting = 0;
  let lastAt = 0;
  for (const job of jobs) {
    if (!job.retry) continue;
    if (job.state === "queued" || job.state === "running") working++;
    else if (job.state === "paused") paused++;
    else if (job.unseen && job.state === "done") unseen++;
    else if (job.unseen && job.state === "failed") failed++;
    if (job.approvals?.length) waiting++;
    lastAt = Math.max(lastAt, job.finishedAt ?? 0, job.startedAt ?? 0);
  }
  return { working, unseen, failed, ...(paused ? { paused } : {}), ...(waiting ? { waiting } : {}), ...(lastAt ? { lastAt } : {}) };
}

export type ServerEvent =
  /** Sent first on every connection: the whole mulch as it is now. */
  | { type: "snapshot"; mulch: Mulch; transcript: TranscriptSegment[]; jobs: JobStatus[]; paused: boolean }
  | { type: "ops"; batch: OpBatch }
  | { type: "transcript"; segment: TranscriptSegment }
  | { type: "job"; job: JobStatus }
  /** The person's work changed in another mulch: the list of other mulches is out of date. */
  | { type: "elsewhere" }
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
