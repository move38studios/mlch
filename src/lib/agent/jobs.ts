/**
 * Agent jobs per napkin, in lanes. Server-only.
 *
 *   input ──▶ fast lane (one at a time; segments that arrive meanwhile are batched)
 *                │ new ideas
 *                ▼
 *             slow lane (enrichment; one at a time, batched; pausable)
 *   "organize…" ──▶ command lane (one at a time, in order)
 *   drops, folders ──▶ ingest lane (one at a time, in order)
 *
 * Jobs run in the server process, not the window: closing the window does
 * not stop them. State lives on globalThis so a dev reload keeps it.
 */

import { getHarness } from "@/lib/agent/server/harnesses";
import type { AgentHarnessStatus, HarnessEvent } from "@/lib/agent/types";
import type { JobLane, JobStatus, TranscriptSegment } from "@/lib/napkin/events";
import { newClientId } from "@/lib/napkin/ids";
import { checkpoint } from "@/lib/napkin/history";
import { emit, getNapkin, setJob } from "@/lib/napkin/store";
import { modelFor, readSettings, type Lane } from "@/lib/settings";
import { commandPrompt, fastPrompt, folderPrompt, ingestPrompt, slowPrompt } from "./prompts";
import { createNapkinTools, describeNapkin, type ToolName } from "./tools";

const TIMEOUT_MS: Record<JobLane, number> = { fast: 120_000, slow: 300_000, command: 600_000, ingest: 600_000 };
/** Status is re-read at most this often before a job (a probe costs a CLI start). */
const STATUS_TTL_MS = 60_000;

interface Work {
  lane: JobLane;
  label: string;
  run(job: JobStatus, signal: AbortSignal): Promise<void>;
}

interface NapkinJobs {
  queues: Record<JobLane, Work[]>;
  running: Partial<Record<JobLane, { job: JobStatus; controller: AbortController }>>;
  /** Fast lane: segments not yet captured. */
  pendingSegments: TranscriptSegment[];
  /** Slow lane: new item ids not yet enriched. */
  pendingEnrich: string[];
  paused: boolean;
}

interface JobsState {
  napkins: Map<string, NapkinJobs>;
  status?: { at: number; value: AgentHarnessStatus };
}

const globalState = globalThis as typeof globalThis & { __npknJobs?: JobsState };
function state(): JobsState {
  return (globalState.__npknJobs ??= { napkins: new Map() });
}

function jobsFor(napkinId: string): NapkinJobs {
  let entry = state().napkins.get(napkinId);
  if (!entry) {
    entry = { queues: { fast: [], slow: [], command: [], ingest: [] }, running: {}, pendingSegments: [], pendingEnrich: [], paused: false };
    state().napkins.set(napkinId, entry);
  }
  return entry;
}

/* ── running one agent turn ────────────────────────────────────── */

interface TurnSpec {
  napkinId: string;
  job: JobStatus;
  signal: AbortSignal;
  lane: Lane;
  systemPrompt: string;
  prompt: string;
  tools: ToolName[];
  webAccess?: boolean;
  allowUserEdits?: boolean;
  readRoot?: string;
  origin?: string;
  onHandOff?: (instruction: string) => void;
}

class JobError extends Error {}

async function harnessReady(): Promise<void> {
  const settings = await readSettings();
  const cached = state().status;
  if (cached && cached.value.id === settings.harness && Date.now() - cached.at < STATUS_TTL_MS && !cached.value.problem) return;
  const status = await getHarness(settings.harness).getStatus();
  state().status = { at: Date.now(), value: status };
  if (status.problem) throw new JobError(status.problem);
}

/** Runs one turn; returns the ids of nodes it added. */
async function runTurn(spec: TurnSpec): Promise<string[]> {
  await harnessReady();
  const settings = await readSettings();
  const ctx = {
    napkinId: spec.napkinId,
    jobId: spec.job.id,
    tools: spec.tools,
    allowUserEdits: spec.allowUserEdits,
    readRoot: spec.readRoot,
    onHandOff: spec.onHandOff,
    origin: spec.origin,
    added: [] as string[],
  };
  const harness = getHarness(settings.harness);
  const events: AsyncIterable<HarnessEvent> = harness.runTurn({
    history: [],
    prompt: spec.prompt,
    systemPrompt: spec.systemPrompt,
    tools: createNapkinTools(ctx),
    model: modelFor(settings, spec.lane),
    webAccess: spec.webAccess,
    signal: spec.signal,
  });
  for await (const event of events) {
    if (event.type === "error") {
      // A refused or failed turn invalidates the cached status.
      state().status = undefined;
      throw new JobError(event.message);
    }
  }
  return ctx.added;
}

/* ── the queue ─────────────────────────────────────────────────── */

async function update(napkinId: string, job: JobStatus, patch: Partial<JobStatus>): Promise<void> {
  Object.assign(job, patch);
  await setJob(napkinId, { ...job });
}

function pump(napkinId: string, lane: JobLane): void {
  const entry = jobsFor(napkinId);
  if (entry.running[lane]) return;
  if (lane === "slow" && entry.paused) return;
  const work = entry.queues[lane].shift();
  if (!work) return;
  const job: JobStatus = { id: newClientId("j"), lane, state: "running", label: work.label, startedAt: Date.now() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Timed out")), TIMEOUT_MS[lane]);
  entry.running[lane] = { job, controller };
  void (async () => {
    try {
      await setJob(napkinId, { ...job });
      await work.run(job, controller.signal);
      await update(napkinId, job, { state: controller.signal.aborted ? "cancelled" : "done", finishedAt: Date.now() });
    } catch (error) {
      const cancelled = controller.signal.aborted && !(controller.signal.reason instanceof Error && controller.signal.reason.message === "Timed out");
      const message = error instanceof Error ? error.message : String(error);
      await update(napkinId, job, { state: cancelled ? "cancelled" : "failed", error: cancelled ? undefined : message, finishedAt: Date.now() }).catch(() => {});
      if (!cancelled) await emit(napkinId, { type: "notice", level: "error", message }).catch(() => {});
      if (!(error instanceof JobError) && !cancelled) console.error(`[jobs] ${lane} job failed`, error);
    } finally {
      clearTimeout(timer);
      await checkpoint(napkinId, "job", work.label).catch((error) => console.error("[jobs] checkpoint failed", error));
      entry.running[lane] = undefined;
      pump(napkinId, lane);
    }
  })();
}

function enqueue(napkinId: string, work: Work): void {
  jobsFor(napkinId).queues[work.lane].push(work);
  pump(napkinId, work.lane);
}

/* ── lanes ─────────────────────────────────────────────────────── */

function inputBlock(segments: TranscriptSegment[]): string {
  return segments.map((segment) => segment.text.trim()).filter(Boolean).join("\n");
}

/** New input from the person: capture it (fast lane), then enrich (slow lane). */
export function submitInput(napkinId: string, segment: TranscriptSegment): void {
  const entry = jobsFor(napkinId);
  entry.pendingSegments.push(segment);
  // One queued fast job drains everything pending when it starts.
  if (entry.queues.fast.length) return;
  enqueue(napkinId, {
    lane: "fast",
    label: "Capturing",
    async run(job, signal) {
      const segments = entry.pendingSegments.splice(0);
      const text = inputBlock(segments);
      if (!text) return;
      const napkin = await getNapkin(napkinId);
      const added = await runTurn({
        napkinId,
        job,
        signal,
        lane: "fast",
        systemPrompt: fastPrompt(),
        prompt: `<napkin>\n${describeNapkin(napkin, { textLimit: 140, maxNodes: 120 })}\n</napkin>\n\n<new_input source="${segments[0]?.source ?? "speech"}">\n${text}\n</new_input>`,
        tools: napkin.title === "Untitled" ? ["add_nodes", "connect", "hand_off", "set_title"] : ["add_nodes", "connect", "hand_off"],
        origin: `speech:${job.id}`,
        onHandOff: (instruction) => submitCommand(napkinId, instruction),
      });
      if (added.length) requestEnrichment(napkinId, added);
    },
  });
}

export function requestEnrichment(napkinId: string, ids: string[]): void {
  const entry = jobsFor(napkinId);
  entry.pendingEnrich.push(...ids);
  if (entry.queues.slow.length) return;
  entry.queues.slow.push({
    lane: "slow",
    label: "Enriching",
    async run(job, signal) {
      const ids = [...new Set(entry.pendingEnrich.splice(0))];
      const napkin = await getNapkin(napkinId);
      const items = ids.map((id) => napkin.nodes[id]).filter(Boolean);
      if (!items.length) return;
      const settings = await readSettings();
      if (!settings.enrich.length) return;
      const web = settings.enrich.includes("search");
      await runTurn({
        napkinId,
        job,
        signal,
        lane: "slow",
        systemPrompt: slowPrompt(settings.enrich, web),
        prompt: `<napkin>\n${describeNapkin(napkin, { textLimit: 160, maxNodes: 150 })}\n</napkin>\n\n<new_items>\n${items.map((n) => `${n.id}: ${n.title ? `${n.title} — ` : ""}${n.text}`).join("\n")}\n</new_items>`,
        tools: ["add_nodes", "connect", "say"],
        webAccess: web,
      });
    },
  });
  pump(napkinId, "slow");
}

export function submitCommand(napkinId: string, instruction: string): void {
  enqueue(napkinId, {
    lane: "command",
    label: instruction.length > 60 ? `${instruction.slice(0, 57)}…` : instruction,
    async run(job, signal) {
      const napkin = await getNapkin(napkinId);
      await runTurn({
        napkinId,
        job,
        signal,
        lane: "command",
        systemPrompt: commandPrompt(),
        prompt: `<napkin>\n${describeNapkin(napkin, { textLimit: 400 })}\n</napkin>\n\n<instruction>\n${instruction}\n</instruction>`,
        tools: ["get_napkin", "add_nodes", "connect", "update_node", "remove_nodes", "arrange", "write_doc", "say"],
        webAccess: true,
        allowUserEdits: true,
      });
    },
  });
}

/** Digest a document or link already on the napkin into items around it. */
export function submitIngest(napkinId: string, sourceId: string, label: string, content: string): void {
  enqueue(napkinId, {
    lane: "ingest",
    label,
    async run(job, signal) {
      const napkin = await getNapkin(napkinId);
      const added = await runTurn({
        napkinId,
        job,
        signal,
        lane: "slow",
        systemPrompt: ingestPrompt(),
        prompt: `<napkin>\n${describeNapkin(napkin, { textLimit: 140, maxNodes: 120 })}\n</napkin>\n\n<source id="${sourceId}">\n${content.slice(0, 150_000)}\n</source>`,
        tools: ["add_nodes", "connect"],
      });
      if (added.length) requestEnrichment(napkinId, added.slice(0, 6));
    },
  });
}

/** Explore a folder and build items from it. */
export function submitFolder(napkinId: string, folder: string): void {
  enqueue(napkinId, {
    lane: "ingest",
    label: `Exploring ${folder.split("/").pop()}`,
    async run(job, signal) {
      await runTurn({
        napkinId,
        job,
        signal,
        lane: "command",
        systemPrompt: folderPrompt(),
        prompt: `Folder: ${folder}`,
        tools: ["list_files", "read_file", "add_nodes", "connect", "arrange", "say", "set_title"],
        readRoot: folder,
      });
    },
  });
}

export function setEnrichmentPaused(napkinId: string, paused: boolean): void {
  const entry = jobsFor(napkinId);
  entry.paused = paused;
  if (paused) entry.running.slow?.controller.abort();
  else pump(napkinId, "slow");
}

export function cancelJobs(napkinId: string): void {
  const entry = jobsFor(napkinId);
  entry.pendingSegments = [];
  entry.pendingEnrich = [];
  for (const lane of Object.keys(entry.queues) as JobLane[]) entry.queues[lane] = [];
  for (const running of Object.values(entry.running)) running?.controller.abort();
}
