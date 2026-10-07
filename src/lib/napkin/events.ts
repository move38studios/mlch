/** What the server streams to an open napkin window (GET /api/napkins/:id/events). */

import type { Napkin, OpBatch } from "./types";

export interface TranscriptSegment {
  id: string;
  /** ms epoch when the chunk was recorded. */
  at: number;
  text: string;
  /** "speech" (transcribed) or "typed". */
  source: "speech" | "typed";
}

export type JobLane = "fast" | "slow" | "command" | "ingest";

export interface JobStatus {
  id: string;
  lane: JobLane;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  /** One short line ("Adding ideas", "Searching: …"). */
  label: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type ServerEvent =
  /** Sent first on every connection: the whole napkin as it is now. */
  | { type: "snapshot"; napkin: Napkin; transcript: TranscriptSegment[]; jobs: JobStatus[]; paused: boolean }
  | { type: "ops"; batch: OpBatch }
  | { type: "transcript"; segment: TranscriptSegment }
  | { type: "job"; job: JobStatus }
  /** Enrichment paused or resumed. */
  | { type: "paused"; paused: boolean }
  /** A short status line from the agent (its `reply` tool). */
  | { type: "say"; text: string; jobId: string }
  | { type: "notice"; level: "error" | "info"; message: string }
  /** The agent shows items: pan to them, highlight; open a document at a page or quote. */
  | { type: "focus"; ids: string[]; page?: number; quote?: string };
