/**
 * Agent jobs per mulch, in lanes. Server-only.
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

import { log } from "@/lib/log";
import { getHarness } from "@/lib/agent/server/harnesses";
import type { AgentHarnessStatus, AgentWorkspace, HarnessEvent } from "@/lib/agent/types";
import type { JobLane, JobRetry, JobStatus, TranscriptSegment, ViewAction } from "@/lib/mulch/events";
import { newClientId } from "@/lib/mulch/ids";
import { checkpoint } from "@/lib/mulch/history";
import { applyToMulch, emit, getJobs, getMulch, keepWhile, listMulches, mulchDir, onAfterApply, onJobChanged, openMulch, setJob } from "@/lib/mulch/store";
import { desktopRequest } from "@/lib/desktop/server";
import { modelFor, readSettings, type Lane, type Settings } from "@/lib/settings";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adoptArtifact } from "@/lib/artifacts/artifacts";
import { privateDirs } from "./files";
import { holdSpace, placeNear } from "@/lib/mulch/place";
import { artifactHeight, NODE_WIDTH } from "@/lib/mulch/sizes";
import { dropEcho } from "@/lib/voice/echo";
import { callPrompt, commandPrompt, fastPrompt, folderPrompt, imagePrompt, ingestPrompt, makerPrompt, researchPrompt, slowPrompt } from "./prompts";
import { onFinished, type GenerationRecord } from "@/lib/media/generations";
import { recordUsage } from "./usage";
import { search } from "@/lib/search";
import { autoSources, syncSources } from "@/lib/sources/sources";
import { cliFailed, prepareCli } from "./server/cli";
// Registers live sharing: shared canvases follow every change.
import "@/lib/share/shares";
import { exaAvailable } from "@/lib/search/exa";
import { createMulchTools, describeMulch, MAX_REVIEW_ROUNDS, type ToolName } from "./tools";

/** Sources longer than this are read in part; the rest is found by search. */
const LONG_SOURCE = 60_000;

const TIMEOUT_MS: Record<JobLane, number> = { fast: 120_000, slow: 300_000, command: 900_000, ingest: 600_000, long: 1_800_000 };
/** Long work (making, research) at once: per mulch, and in all (it all runs on one subscription). */
const LONG_PER_MULCH = 2;
const LONG_TOTAL = 3;
/** The space held on the canvas for a long job's result. */
const RESULT_SIZE = { w: NODE_WIDTH.artifact, h: 220 };
/** Status is re-read at most this often before a job (a probe costs a CLI start). */
const STATUS_TTL_MS = 60_000;

interface Work {
  lane: JobLane;
  label: string;
  /** The person's instructions and long work: kept, and can be started again. */
  retry?: JobRetry;
  /** Long work: the items its result belongs near. */
  near?: string[];
  run(job: JobStatus, signal: AbortSignal): Promise<void>;
}

interface Queued {
  work: Work;
  job: JobStatus;
}

interface Running {
  job: JobStatus;
  controller: AbortController;
}

interface MulchJobs {
  queues: Record<JobLane, Queued[]>;
  running: Record<JobLane, Running[]>;
  /** Fast lane: segments not yet captured. */
  pendingSegments: TranscriptSegment[];
  /** Slow lane: new item ids not yet enriched. */
  pendingEnrich: string[];
  paused: boolean;
  /** A call is being listened to: speech is captured in batches every CALL_BATCH_MS. */
  call?: { segments: TranscriptSegment[]; timer?: ReturnType<typeof setTimeout> };
}

interface JobsState {
  mulches: Map<string, MulchJobs>;
  status?: { at: number; value: AgentHarnessStatus };
}

const globalState = globalThis as typeof globalThis & { __mlchJobs?: JobsState };
function state(): JobsState {
  return (globalState.__mlchJobs ??= { mulches: new Map() });
}

function jobsFor(mulchId: string): MulchJobs {
  let entry = state().mulches.get(mulchId);
  if (!entry) {
    entry = {
      queues: { fast: [], slow: [], command: [], ingest: [], long: [] },
      running: { fast: [], slow: [], command: [], ingest: [], long: [] },
      pendingSegments: [],
      pendingEnrich: [],
      paused: false,
    };
    state().mulches.set(mulchId, entry);
  }
  return entry;
}

/* ── running one agent turn ────────────────────────────────────── */

interface TurnSpec {
  mulchId: string;
  job: JobStatus;
  signal: AbortSignal;
  lane: Lane;
  /** Built from the settings at the start of the turn, so edited prompts apply at once. */
  systemPrompt: string | ((settings: Settings) => string);
  prompt: string;
  tools: ToolName[];
  webAccess?: boolean;
  allowUserEdits?: boolean;
  readRoot?: string;
  origin?: string;
  onHandOff?: (instruction: string) => void;
  onMake?: (brief: string, options: LongOptions) => void;
  onResearch?: (brief: string, options: LongOptions) => void;
  /** Where a long job's own result goes, if nothing says otherwise. */
  anchor?: { x: number; y: number };
  workspace?: AgentWorkspace;
  /** The person's request (kept for review turns). */
  brief?: string;
  /** Resume this vendor session. */
  sessionId?: string;
  reviewRound?: number;
  /** Linked folders it may search: all when the person asked for this job. */
  sources?: "all" | "auto";
}

class JobError extends Error {}

async function harnessReady(): Promise<void> {
  const settings = await readSettings();
  // Packaged app with no usable install: the tested CLI downloads (the turn waits for it below).
  await prepareCli(settings.harness, { download: true });
  const cached = state().status;
  if (cached && cached.value.id === settings.harness && Date.now() - cached.at < STATUS_TTL_MS && !cached.value.problem) return;
  const status = await getHarness(settings.harness).getStatus();
  state().status = { at: Date.now(), value: status };
  if (status.problem) throw new JobError(status.problem);
}

/** Our tools, as the person would describe what the job is doing. */
const TOOL_ACTIVITY: Record<string, string> = {
  web_search: "Searching the web",
  exa_search: "Searching the web",
  read_page: "Reading a page",
  add_nodes: "Adding to the canvas",
  connect: "Connecting items",
  arrange: "Arranging",
  write_doc: "Writing",
  write_artifact: "Writing a page",
  preview_artifact: "Checking the page",
  present_file: "Putting it on the canvas",
  view_image: "Looking at an image",
  search_mulch: "Searching this canvas",
  search_all_mulches: "Searching your mulches and notes",
  link_to: "Linking",
  save_note: "Saving a note",
  read_source: "Reading a source",
  read_file: "Reading a file",
  list_files: "Looking through files",
  find_files: "Looking through files",
  media_generate: "Generating media",
  media_wait: "Waiting for media",
  make_pptx: "Making a deck",
};

/** A CLI's own tool use (making turns) as a short line. */
function describeToolUse(name: string, input: Record<string, unknown> = {}): string | undefined {
  const file = typeof input.file_path === "string" ? path.basename(input.file_path) : typeof input.path === "string" ? path.basename(input.path) : undefined;
  const command = typeof input.command === "string" ? input.command.replace(/\s+/g, " ").trim() : undefined;
  switch (name) {
    case "Write":
      return file ? `Writing ${file}` : "Writing a file";
    case "Edit":
    case "MultiEdit":
      return file ? `Editing ${file}` : "Editing a file";
    case "Read":
      return file ? `Reading ${file}` : "Reading a file";
    case "Bash":
      if (!command) return "Running a command";
      if (/\b(pip|uv|npm|pnpm|brew) (install|add)\b/.test(command)) return "Installing tools";
      if (/soffice|libreoffice|pdftoppm|convert\b/.test(command)) return "Rendering a preview";
      return `Running ${command.split(" ").slice(0, 3).join(" ").slice(0, 40)}`;
    case "WebSearch":
      return typeof input.query === "string" ? `Searching: ${input.query}` : "Searching the web";
    case "WebFetch":
      return "Reading a page";
    case "Glob":
    case "Grep":
    case "LS":
      return "Looking through files";
    default:
      return undefined;
  }
}

function lastSentence(text: string): string | undefined {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?:])\s+/).filter((s) => s.length > 3);
  const last = sentences.at(-1)?.replace(/[:.]$/, "");
  return last && last.length <= 120 ? last : last ? `${last.slice(0, 117)}…` : undefined;
}

/** A long job's held place, given up on first use; the canvas stops showing the placeholder. */
function takeHeld(mulchId: string, job: JobStatus): { x: number; y: number } | undefined {
  const anchor = job.anchor;
  if (!anchor) return undefined;
  holdSpace(mulchId, job.id, undefined);
  job.anchor = undefined;
  sendLive(mulchId, job);
  return { x: anchor.x, y: anchor.y };
}

/** Runs one turn; returns the ids of nodes it added and the vendor session. */
async function runTurnWithSession(spec: TurnSpec): Promise<{ added: string[]; sessionId?: string }> {
  await harnessReady();
  const settings = await readSettings();
  const ctx = {
    mulchId: spec.mulchId,
    jobId: spec.job.id,
    tools: spec.tools,
    allowUserEdits: spec.allowUserEdits,
    readRoot: spec.readRoot,
    onHandOff: spec.onHandOff,
    onMake: spec.onMake,
    onResearch: spec.onResearch,
    takeHeld: () => takeHeld(spec.mulchId, spec.job),
    onActivity: (text: string) => setActivity(spec.mulchId, spec.job, text),
    origin: spec.origin,
    brief: spec.brief,
    reviewRound: spec.reviewRound,
    sources: spec.sources,
    session: { id: spec.sessionId } as { id?: string },
    added: [] as string[],
  };
  const harness = getHarness(settings.harness);
  const events: AsyncIterable<HarnessEvent> = harness.runTurn({
    ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
    history: [],
    prompt: spec.prompt,
    systemPrompt: typeof spec.systemPrompt === "string" ? spec.systemPrompt : spec.systemPrompt(settings),
    tools: createMulchTools(ctx),
    model: modelFor(settings, spec.lane),
    webAccess: spec.webAccess,
    workspace: spec.workspace,
    signal: spec.signal,
  });
  // The model's own words, sentence by sentence, are the best "what it is doing now".
  const said = new Map<string, string>();
  for await (const event of events) {
    if (event.type === "session") ctx.session.id = event.sessionId;
    if (event.type === "tool-pending") setActivity(spec.mulchId, spec.job, TOOL_ACTIVITY[event.toolName]);
    if (event.type === "tool-use") setActivity(spec.mulchId, spec.job, describeToolUse(event.name, event.input));
    if (event.type === "text-delta") said.set(event.id, (said.get(event.id) ?? "") + event.delta);
    if (event.type === "text-end") setActivity(spec.mulchId, spec.job, lastSentence(said.get(event.id) ?? ""));
    if (event.type === "usage") {
      void recordUsage(settings.harness, spec.lane, event.inputTokens ?? 0, event.outputTokens ?? 0);
      log.info("agent", "turn usage", { mulchId: spec.mulchId, jobId: spec.job.id, harness: settings.harness, lane: spec.lane, model: modelFor(settings, spec.lane), inputTokens: event.inputTokens, outputTokens: event.outputTokens });
    }
    if (event.type === "error") {
      log.warn("agent", "turn error", { mulchId: spec.mulchId, jobId: spec.job.id, harness: settings.harness, code: event.code, message: event.message });
      // A refused or failed turn invalidates the cached status.
      state().status = undefined;
      // The CLI itself broke (not a refusal): if it was the person's own install, use the tested version next time.
      if (event.code === "harness_error" || event.code === "not_installed") cliFailed(settings.harness);
      throw new JobError(event.message);
    }
  }
  return { added: ctx.added, sessionId: ctx.session.id };
}

async function runTurn(spec: TurnSpec): Promise<string[]> {
  return (await runTurnWithSession(spec)).added;
}

/* ── the queue ─────────────────────────────────────────────────── */

async function update(mulchId: string, job: JobStatus, patch: Partial<JobStatus>): Promise<void> {
  Object.assign(job, patch);
  await setJob(mulchId, { ...job });
}

/** Activity and results change often; send them at most this often. */
const LIVE_MS = 700;
const liveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sendLive(mulchId: string, job: JobStatus): void {
  if (liveTimers.has(job.id)) return;
  liveTimers.set(
    job.id,
    setTimeout(() => {
      liveTimers.delete(job.id);
      if (job.state === "running") void setJob(mulchId, { ...job }).catch(() => {});
    }, LIVE_MS),
  );
}

function setActivity(mulchId: string, job: JobStatus, activity: string | undefined): void {
  const text = activity?.replace(/\s+/g, " ").trim();
  if (!text || text === job.activity) return;
  job.activity = text.length > 90 ? `${text.slice(0, 87)}…` : text;
  sendLive(mulchId, job);
}

function findRunning(mulchId: string, jobId: string): Running | undefined {
  const entry = state().mulches.get(mulchId);
  if (!entry) return undefined;
  for (const list of Object.values(entry.running)) {
    const found = list.find((running) => running.job.id === jobId);
    if (found) return found;
  }
  return undefined;
}

function canStart(mulchId: string, lane: JobLane): boolean {
  const entry = jobsFor(mulchId);
  if (lane === "slow" && entry.paused) return false;
  if (lane !== "long") return entry.running[lane].length === 0;
  if (entry.running.long.length >= LONG_PER_MULCH) return false;
  let total = 0;
  for (const other of state().mulches.values()) total += other.running.long.length;
  return total < LONG_TOTAL;
}

function pump(mulchId: string, lane: JobLane): void {
  const entry = jobsFor(mulchId);
  while (entry.queues[lane].length && canStart(mulchId, lane)) start(mulchId, entry.queues[lane].shift()!);
}

/** A long slot came free: any mulch may use it. */
function pumpLong(): void {
  for (const mulchId of state().mulches.keys()) pump(mulchId, "long");
}

function start(mulchId: string, { work, job }: Queued): void {
  const entry = jobsFor(mulchId);
  const lane = work.lane;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Timed out")), TIMEOUT_MS[lane]);
  const running: Running = { job, controller };
  entry.running[lane].push(running);
  void (async () => {
    try {
      const patch: Partial<JobStatus> = { state: "running", startedAt: Date.now() };
      if (lane === "long") {
        // Hold the space where the result will land, so the canvas can show the work there.
        const mulch = await getMulch(mulchId);
        const at = placeNear(mulch, RESULT_SIZE, { anchorIds: work.near, seed: job.id });
        patch.anchor = { ...at, ...RESULT_SIZE };
        holdSpace(mulchId, job.id, patch.anchor);
      }
      await update(mulchId, job, patch);
      log.info("jobs", "job started", { mulchId, jobId: job.id, lane, label: work.label });
      await work.run(job, controller.signal);
      const cancelled = controller.signal.aborted;
      log.info("jobs", cancelled ? "job cancelled" : "job finished", { mulchId, jobId: job.id, lane, ms: Date.now() - (job.startedAt ?? Date.now()) });
      await update(mulchId, job, {
        state: cancelled ? "cancelled" : "done",
        finishedAt: Date.now(),
        activity: undefined,
        anchor: undefined,
        // The person should know something new landed.
        unseen: !cancelled && !!work.retry && !!job.resultIds?.length,
      });
    } catch (error) {
      const timedOut = controller.signal.reason instanceof Error && controller.signal.reason.message === "Timed out";
      const cancelled = controller.signal.aborted && !timedOut;
      const message = error instanceof Error ? error.message : String(error);
      await update(mulchId, job, {
        state: cancelled ? "cancelled" : "failed",
        error: cancelled ? undefined : message,
        finishedAt: Date.now(),
        activity: undefined,
        anchor: undefined,
        unseen: !cancelled && !!work.retry,
      }).catch(() => {});
      if (!cancelled && !work.retry) await emit(mulchId, { type: "notice", level: "error", message }).catch(() => {});
      if (!cancelled) log.error("jobs", "job failed", { mulchId, jobId: job.id, lane, label: work.label, ms: Date.now() - (job.startedAt ?? Date.now()), error });
    } finally {
      clearTimeout(timer);
      clearTimeout(liveTimers.get(job.id));
      liveTimers.delete(job.id);
      holdSpace(mulchId, job.id, undefined);
      await checkpoint(mulchId, "job", work.label).catch((error) => log.error("history", "checkpoint failed", { mulchId, error }));
      entry.running[lane] = entry.running[lane].filter((r) => r !== running);
      pump(mulchId, lane);
      if (lane === "long") pumpLong();
    }
  })();
}

/** Queue work without starting it; returns its job. */
function queue(mulchId: string, work: Work): JobStatus {
  const job: JobStatus = { id: newClientId("j"), lane: work.lane, state: "queued", label: work.label, queuedAt: Date.now(), ...(work.retry ? { retry: work.retry } : {}) };
  jobsFor(mulchId).queues[work.lane].push({ work, job });
  // Only the person's own requests are worth showing while they wait.
  if (work.retry) void setJob(mulchId, { ...job }).catch(() => {});
  return job;
}

function enqueue(mulchId: string, work: Work): JobStatus {
  const job = queue(mulchId, work);
  pump(mulchId, work.lane);
  return job;
}

// Items a running job adds are its results.
onAfterApply((mulchId, batch) => {
  const jobId = batch.origin.split(":")[1];
  if (!jobId) return;
  const running = findRunning(mulchId, jobId);
  if (!running) return;
  const added = batch.ops.flatMap((op) => (op.op === "addNode" ? [op.node.id] : []));
  if (!added.length) return;
  running.job.resultIds = [...(running.job.resultIds ?? []), ...added];
  sendLive(mulchId, running.job);
});

/** A long job's short name and the items it is about. */
export interface LongOptions {
  title?: string;
  near?: string[];
}

function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/* ── lanes ─────────────────────────────────────────────────────── */

function inputBlock(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => (segment.speaker ? `[${segment.speaker}] ${segment.text.trim()}` : segment.text.trim()))
    .filter((line) => line && !/^\[(me|them)\]\s*$/.test(line))
    .join("\n");
}

/** The call's conversation for a prompt, or nothing when there was no call. */
function conversationBlock(text: string): string {
  return text ? `<conversation>\nThe call on this canvas, [me] = the person, [them] = the others (most recent last):\n${text}\n</conversation>\n\n` : "";
}

/** A call's speech is captured every this often (a conversation needs context; a braindump wants speed). */
export const CALL_BATCH_MS = Number(process.env.MLCH_CALL_BATCH_MS) || 30_000;

/** Start or stop call capture for a mulch (the system-audio capture starts and stops it). Stopping captures what is left. */
export function setCallMode(mulchId: string, on: boolean): void {
  const entry = jobsFor(mulchId);
  if (on) {
    entry.call ??= { segments: [] };
    return;
  }
  if (!entry.call) return;
  clearTimeout(entry.call.timer);
  const rest = entry.call.segments.splice(0);
  entry.call = undefined;
  if (rest.length) captureCall(mulchId, rest);
}

export function inCall(mulchId: string): boolean {
  return !!state().mulches.get(mulchId)?.call;
}

keepWhile((mulchId) => inCall(mulchId));

function flushCall(mulchId: string): void {
  const call = jobsFor(mulchId).call;
  if (!call) return;
  call.timer = undefined;
  const segments = call.segments.splice(0);
  if (segments.length) captureCall(mulchId, segments);
}

function captureCall(mulchId: string, raw: TranscriptSegment[]): void {
  const segments = dropEcho(raw);
  const text = inputBlock(segments);
  if (!text) return;
  enqueue(mulchId, {
    lane: "fast",
    label: "Capturing",
    async run(job, signal) {
      const mulch = await getMulch(mulchId);
      const added = await runTurn({
        mulchId,
        job,
        signal,
        lane: "fast",
        systemPrompt: callPrompt,
        prompt: `<mulch>\n${await mulchContext(mulchId, text, 140)}\n</mulch>\n\n<call_so_far>\n${await callTranscript(mulchId, { minutes: 6, before: segments[0]?.at })}\n</call_so_far>\n\n<new_conversation>\n${text}\n</new_conversation>`,
        tools: [...CAPTURE_TOOLS, ...(mulch.title === "Untitled" ? (["set_title"] as const) : [])],
        origin: `speech:${job.id}`,
        onHandOff: (instruction) => submitCommand(mulchId, instruction),
      });
      if (added.length) requestEnrichment(mulchId, added);
    },
  });
}

/**
 * The recent conversation in a call, with who said what, for capture context
 * and for instructions given during or after a call ("make a deck from what
 * we just discussed"). Empty when the mulch has no call.
 */
export async function callTranscript(mulchId: string, options: { minutes?: number; before?: number; maxChars?: number } = {}): Promise<string> {
  const transcript = (await openMulch(mulchId)).transcript;
  const spoken = transcript.filter((segment) => segment.speaker);
  if (!spoken.length) return "";
  const until = options.before ?? Infinity;
  const since = (spoken.filter((s) => s.at < until).at(-1)?.at ?? 0) - (options.minutes ?? 30) * 60_000;
  const lines = spoken.filter((s) => s.at >= since && s.at < until).map((s) => `[${s.speaker}] ${s.text.trim()}`);
  const text = lines.join("\n");
  const max = options.maxChars ?? 24_000;
  return text.length > max ? `…${text.slice(-max)}` : text;
}

const CAPTURE_TOOLS: ToolName[] = ["add_nodes", "connect", "hand_off", "focus", "view"];

/** New input from the person: capture it (fast lane), then enrich (slow lane). */
/** Plain view commands, acted on without a model turn. Anything else goes through capture. */
const VIEW_COMMANDS: [RegExp, ViewAction][] = [
  [/^(please )?zoom out( a bit| more)?( please)?$/, "out"],
  [/^(please )?zoom in( a bit| more)?( please)?$/, "in"],
  [/^(please )?(show (me )?(everything|it all|the whole (thing|canvas))|fit( to screen| everything)?|see everything)( please)?$/, "fit"],
];

function viewCommand(text: string): ViewAction | undefined {
  const plain = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  return VIEW_COMMANDS.find(([pattern]) => pattern.test(plain))?.[1];
}

export function submitInput(mulchId: string, segment: TranscriptSegment): void {
  const entry = jobsFor(mulchId);
  // In a call, speech is gathered and captured as conversation; typing still goes straight through.
  if (entry.call && segment.source === "speech") {
    entry.call.segments.push(segment);
    entry.call.timer ??= setTimeout(() => flushCall(mulchId), CALL_BATCH_MS);
    return;
  }
  const action = viewCommand(segment.text);
  if (action) {
    void emit(mulchId, { type: "view", action });
    return;
  }
  entry.pendingSegments.push(segment);
  // One queued fast job drains everything pending when it starts.
  if (entry.queues.fast.length) return;
  enqueue(mulchId, {
    lane: "fast",
    label: "Capturing",
    async run(job, signal) {
      const segments = entry.pendingSegments.splice(0);
      const text = inputBlock(segments);
      if (!text) return;
      const mulch = await getMulch(mulchId);
      const added = await runTurn({
        mulchId,
        job,
        signal,
        lane: "fast",
        systemPrompt: fastPrompt,
        prompt: `<mulch>\n${await mulchContext(mulchId, text, 140)}\n</mulch>\n\n<new_input source="${segments[0]?.source ?? "speech"}">\n${text}\n</new_input>`,
        tools: [...CAPTURE_TOOLS, ...(mulch.title === "Untitled" ? (["set_title"] as const) : [])],
        origin: `speech:${job.id}`,
        onHandOff: (instruction) => submitCommand(mulchId, instruction),
      });
      if (added.length) requestEnrichment(mulchId, added);
    },
  });
}

export function requestEnrichment(mulchId: string, ids: string[]): void {
  const entry = jobsFor(mulchId);
  entry.pendingEnrich.push(...ids);
  if (entry.queues.slow.length) return;
  queue(mulchId, {
    lane: "slow",
    label: "Enriching",
    async run(job, signal) {
      const ids = [...new Set(entry.pendingEnrich.splice(0))];
      const mulch = await getMulch(mulchId);
      const items = ids.map((id) => mulch.nodes[id]).filter(Boolean);
      if (!items.length) return;
      const settings = await readSettings();
      if (!settings.enrich.length) return;
      const web = settings.enrich.includes("search");
      const about = items.map((n) => `${n.title ?? ""} ${n.text}`).join(" ").slice(0, 1000);
      await runTurn({
        mulchId,
        job,
        signal,
        lane: "slow",
        systemPrompt: (s) => slowPrompt(s, web),
        prompt:
          `<mulch>\n${await mulchContext(mulchId, about, 160)}\n</mulch>\n\n<new_items>\n${items.map((n) => `${n.id}: ${n.title ? `${n.title} — ` : ""}${n.text}`).join("\n")}\n</new_items>` +
          (settings.enrich.includes("mulches") ? await relatedElsewhere(mulchId, about) : ""),
        tools: [
          "add_nodes", "connect", "say",
          ...(settings.enrich.includes("mulches") ? (["search_all_mulches", "read_source", "link_to"] as ToolName[]) : []),
          ...(web && exaAvailable() ? (["exa_search"] as ToolName[]) : []),
        ],
        webAccess: web,
      });
    },
  });
  pump(mulchId, "slow");
}

const COMMAND_TOOLS: ToolName[] = [
  "get_mulch", "add_nodes", "connect", "update_node", "remove_nodes", "arrange", "write_doc", "say",
  "write_artifact", "preview_artifact", "make_pptx", "make", "view_image", "caption_image", "list_files", "find_files", "read_file",
  "media_search", "media_schema", "media_generate", "media_wait", "media_view",
  "search_mulch", "search_all_mulches", "read_source", "focus", "view", "bring_in", "link_to", "save_note", "research", "read_page",
];

const RESEARCH_TOOLS: ToolName[] = [
  "read_page", "add_nodes", "connect", "arrange", "write_artifact", "preview_artifact", "write_doc", "say", "get_mulch", "search_mulch",
  "search_all_mulches", "read_source", "link_to",
];

/**
 * A research job: many searches and reading, then sources, a comparison table
 * and a write-up on the canvas. If the turn ends without the table or the
 * write-up, the same session is resumed once with what is missing.
 */
export function submitResearch(mulchId: string, brief: string, options: LongOptions = {}): JobStatus {
  return enqueue(mulchId, {
    lane: "long",
    label: options.title || shorten(brief, 50),
    retry: { kind: "research", input: brief, ...options },
    near: options.near,
    async run(job, signal) {
      const exa = exaAvailable();
      const spec: TurnSpec = {
        mulchId,
        job,
        signal,
        lane: "command",
        systemPrompt: researchPrompt,
        prompt: `<mulch>\n${await mulchContext(mulchId, brief, 300)}\n</mulch>\n\n<brief>\n${brief}\n</brief>${await relatedElsewhere(mulchId, brief, { limit: 10 })}`,
        tools: exa ? [...RESEARCH_TOOLS, "exa_search"] : RESEARCH_TOOLS,
        webAccess: true,
        brief,
      };
      const first = await runTurnWithSession(spec);
      const made = async () => {
        const mulch = await getMulch(mulchId);
        const mine = Object.values(mulch.nodes).filter((n) => n.origin === `agent:${job.id}`);
        return {
          sources: mine.filter((n) => n.kind === "search").length,
          table: mine.some((n) => n.kind === "artifact"),
          writeup: mine.some((n) => n.kind === "writeup"),
        };
      };
      const outcome = await made();
      if ((outcome.table && outcome.writeup && outcome.sources >= 5) || signal.aborted || !first.sessionId) return;
      const missing = [
        outcome.sources < 5 ? `more sources (${outcome.sources} so far; aim for 8-15 real ones, read their pages)` : "",
        outcome.table ? "" : "the comparison table (write_artifact, html)",
        outcome.writeup ? "" : "the write-up (write_doc)",
      ].filter(Boolean);
      log.info("jobs", "research incomplete, continuing", { mulchId, jobId: job.id, missing });
      await runTurnWithSession({
        ...spec,
        sessionId: first.sessionId,
        prompt: `You are not finished. Still missing: ${missing.join("; ")}. Do these now, then say one line.`,
      });
    },
  });
}

/** Tools that need a key the person may not have set. */
function withKeyTools(tools: ToolName[]): ToolName[] {
  return exaAvailable() ? [...tools, "exa_search"] : tools;
}

/**
 * The mulch as the agent sees it in a prompt: everything when it is small;
 * when it is big, the newest items plus the ones that match what this turn
 * is about (the agent can search for more).
 */
/**
 * What the person already has elsewhere that may bear on this turn: the best
 * search hits in their other mulches and linked folders, found in code so the
 * model only judges the connection (it rarely searches on its own).
 */
async function relatedElsewhere(mulchId: string, about: string, options: { limit?: number; sources?: "all" | "auto" } = {}): Promise<string> {
  if (!about.trim()) return "";
  try {
    const sources = options.sources === "all" ? await syncSources() : await autoSources();
    const others = (await listMulches()).filter((m) => m.id !== mulchId);
    const titles = new Map(others.map((m) => [m.id, m.title]));
    const names = new Map(sources.map((s) => [s.id, s.name]));
    const hits = await search(about, { mulchIds: others.map((m) => m.id), sources: sources.map((s) => s.id), limit: options.limit ?? 6 });
    if (!hits.length) return "";
    const lines = hits.map((hit) =>
      hit.sourceId
        ? `folder ${hit.sourceId} "${names.get(hit.sourceId) ?? ""}" · file ${hit.path}: ${hit.snippet}`
        : `mulch ${hit.mulchId} "${titles.get(hit.mulchId) ?? ""}" · item ${hit.nodeId} [${hit.kind}]${hit.title ? ` "${hit.title}"` : ""}: ${hit.snippet}`,
    );
    return `\n\n<elsewhere>\nFrom the person's other mulches and linked folders, found by search (may or may not be related):\n${lines.join("\n")}\n</elsewhere>`;
  } catch (error) {
    log.warn("jobs", "searching elsewhere failed", { mulchId, error });
    return "";
  }
}

async function mulchContext(mulchId: string, about: string, textLimit: number): Promise<string> {
  const mulch = await getMulch(mulchId);
  const count = Object.keys(mulch.nodes).length;
  if (count <= 150) return describeMulch(mulch, { textLimit });
  const recent = describeMulch(mulch, { textLimit, maxNodes: 80 });
  const hits = about.trim() ? await search(about, { mulchIds: [mulchId], limit: 25 }).catch(() => []) : [];
  const relevant = hits.length
    ? `\n\nOlder items related to this turn (from search; use search_mulch for more):\n${hits.map((h) => `${h.nodeId} [${h.kind}]${h.title ? ` "${h.title}"` : ""}${h.page ? ` p.${h.page}` : ""}: ${h.snippet}`).join("\n")}`
    : "";
  return recent + relevant;
}

/** A long generation finished that its turn asked to review: resume that session to check it. */
function submitReview(mulchId: string, record: GenerationRecord): void {
  const review = record.review!;
  enqueue(mulchId, {
    lane: "command",
    label: `Checking ${record.title}`,
    async run(job, signal) {
      const mulch = await getMulch(mulchId);
      const outcome =
        record.status === "done"
          ? `finished: item ${record.nodeId}${record.extraNodeIds.length ? ` (more outputs: ${record.extraNodeIds.join(", ")})` : ""}. Look at it with media_view.`
          : `${record.status}${record.error ? `: ${record.error}` : ""}.`;
      await runTurn({
        mulchId,
        job,
        signal,
        lane: "command",
        systemPrompt: commandPrompt,
        prompt:
          `<mulch>\n${describeMulch(mulch, { textLimit: 300 })}\n</mulch>\n\n` +
          `Generation ${record.id} "${record.title}" (${record.endpoint}) ${outcome}\n` +
          `It was for: ${review.brief}\n\n` +
          `Check it against what was asked. If it clearly misses (wrong content, artefacts, wrong length or style), generate again with a better prompt or model, ` +
          `with review: true (this was round ${review.round} of ${MAX_REVIEW_ROUNDS}). If it is good, say so in one short line. Do not regenerate for small taste differences.`,
        tools: withKeyTools(COMMAND_TOOLS),
        webAccess: true,
        allowUserEdits: true,
        readRoot: os.homedir(),
        brief: review.brief,
        reviewRound: review.round,
        ...(review.sessionId ? { sessionId: review.sessionId } : {}),
        onMake: (brief, options) => submitMake(mulchId, brief, options),
        onResearch: (brief, options) => submitResearch(mulchId, brief, options),
      });
    },
  });
}

/* ── naming ──────────────────────────────────────────────────── */

/** Mulches already being named in this process, so each is asked once. */
const naming = new Set<string>();

/**
 * An untitled mulch with a couple of items gets a name, whatever filled it
 * (notes typed on the canvas, dropped files, ingest). Capture and folder jobs
 * name it in their own turn; this covers everything else.
 */
export function nameIfUntitled(mulchId: string): void {
  if (naming.has(mulchId)) return;
  naming.add(mulchId);
  // Let the first few changes land first, and give capture a chance to name it itself.
  setTimeout(() => {
    void (async () => {
      const mulch = await getMulch(mulchId).catch(() => undefined);
      if (!mulch || mulch.title !== "Untitled" || Object.keys(mulch.nodes).length < 2) {
        naming.delete(mulchId);
        return;
      }
      enqueue(mulchId, {
        lane: "fast",
        label: "Naming",
        async run(job, signal) {
          const current = await getMulch(mulchId);
          if (current.title !== "Untitled") return;
          await runTurn({
            mulchId,
            job,
            signal,
            lane: "fast",
            systemPrompt: `You name canvases in mlch. Call set_title once with a name for the canvas in the message, then stop.`,
            prompt: `<canvas>\n${describeMulch(current, { textLimit: 200, maxNodes: 40 })}\n</canvas>`,
            tools: ["set_title"],
          });
        },
      });
    })();
  }, 8000);
}

onAfterApply((mulchId, batch) => {
  if (batch.ops.some((op) => op.op === "addNode")) nameIfUntitled(mulchId);
});

/* ── telling the person ─────────────────────────────────────────── */

/** Jobs already announced, so each finish is announced once. */
const announced = new Set<string>();
let activityTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * A finished long job, or an instruction that took a while, is announced with
 * a notification (main shows it only when the person is not looking at that
 * mulch). The Dock badge counts finished results not yet seen, and main asks
 * before quitting while work is running.
 */
onJobChanged((mulchId, job) => {
  const finished = job.state === "done" || job.state === "failed";
  const took = (job.finishedAt ?? 0) - (job.startedAt ?? Date.now());
  if (finished && job.unseen && !announced.has(job.id) && (job.lane === "long" || took > 20_000)) {
    announced.add(job.id);
    void getMulch(mulchId)
      .then((mulch) =>
        desktopRequest("notify", {
          mulchId,
          ids: job.resultIds ?? [],
          title: job.label,
          body: job.state === "failed" ? (job.error ?? "") : mulch.title,
          failed: job.state === "failed",
        }),
      )
      .catch(() => {});
  }
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    void listMulches()
      .then((all) => {
        const total = all.reduce((sum, m) => ({ working: sum.working + (m.activity?.working ?? 0), unseen: sum.unseen + (m.activity?.unseen ?? 0) }), { working: 0, unseen: 0 });
        return desktopRequest("activity", total);
      })
      .catch(() => {});
  }, 500);
});

onFinished((record) => {
  if (record.review && record.status !== "cancelled") submitReview(record.mulchId, record);
});

export function submitCommand(mulchId: string, instruction: string): JobStatus {
  return enqueue(mulchId, {
    lane: "command",
    label: shorten(instruction, 60),
    retry: { kind: "command", input: instruction },
    async run(job, signal) {
      await getMulch(mulchId); // a missing mulch fails the job here
      await runTurn({
        mulchId,
        job,
        signal,
        lane: "command",
        systemPrompt: commandPrompt,
        prompt:
          `<mulch>\n${await mulchContext(mulchId, instruction, 400)}\n</mulch>\n\n${conversationBlock(await callTranscript(mulchId))}` +
          `Readable files: ${os.homedir()} (read-only; credentials and app data excluded)\n\n<instruction>\n${instruction}\n</instruction>${await relatedElsewhere(mulchId, instruction, { sources: "all" })}`,
        tools: withKeyTools(COMMAND_TOOLS),
        // The person asked: every linked folder, including ones kept for when they ask.
        sources: "all",
        brief: instruction,
        onResearch: (brief, options) => submitResearch(mulchId, brief, options),
        onMake: (brief, options) => submitMake(mulchId, brief, options),
        webAccess: true,
        allowUserEdits: true,
        // Instructions may read the person's files ("look at my dev/briefbuster folder"), read-only.
        readRoot: os.homedir(),
      });
    },
  });
}

/** Digest a document or link already on the canvas into items around it. */
export function submitIngest(mulchId: string, sourceId: string, label: string, content: string): void {
  enqueue(mulchId, {
    lane: "ingest",
    label,
    async run(job, signal) {
      await getMulch(mulchId); // a missing mulch fails the job here
      const added = await runTurn({
        mulchId,
        job,
        signal,
        lane: "slow",
        systemPrompt: ingestPrompt,
        prompt:
          `<mulch>\n${await mulchContext(mulchId, content.slice(0, 1000), 140)}\n</mulch>\n\n` +
          (content.length > LONG_SOURCE
            ? `This source is long (${Math.round(content.length / 1000)}k characters; the opening is below). Add at most 8 items: what it is, its main argument or structure, and the parts most relevant to this canvas. Its full text is searchable with search_mulch and read_source, so do not summarise it all.\n\n`
            : "") +
          `<source id="${sourceId}">\n${content.slice(0, LONG_SOURCE)}\n</source>`,
        tools: ["add_nodes", "connect", "search_mulch", "read_source"],
      });
      if (added.length) requestEnrichment(mulchId, added.slice(0, 6));
    },
  });
}

/** Hosts a making job's commands may reach: package registries and font/CDN hosts. */
const MAKER_HOSTS = [
  "pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "github.com", "objects.githubusercontent.com",
  "release-assets.githubusercontent.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com",
];

function makerWorkspace(mulchId: string): AgentWorkspace {
  const dir = mulchDir(mulchId);
  const cwd = path.join(dir, "work");
  const cache = path.join(cwd, ".cache");
  return {
    cwd,
    writable: [path.join(dir, "artifacts")],
    readDenied: privateDirs(),
    networkDomains: MAKER_HOSTS,
    // Tools keep their caches inside the workspace, which is all they may write.
    env: {
      UV_CACHE_DIR: path.join(cache, "uv"),
      UV_PYTHON_INSTALL_DIR: path.join(cache, "uv-python"),
      PIP_CACHE_DIR: path.join(cache, "pip"),
      npm_config_cache: path.join(cache, "npm"),
      XDG_CACHE_HOME: cache,
      MPLCONFIGDIR: path.join(cache, "matplotlib"),
    },
  };
}

/** Files in artifacts/ changed since `since`, as mulch-relative paths (renamed safe). */
async function newArtifacts(mulchId: string, since: number): Promise<string[]> {
  const dir = path.join(mulchDir(mulchId), "artifacts");
  const found: string[] = [];
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const stat = await fs.stat(path.join(dir, name)).catch(() => undefined);
    if (!stat?.isFile() || stat.mtimeMs < since - 1000) continue;
    const adopted = await adoptArtifact(mulchId, name);
    if (adopted) found.push(adopted);
  }
  return found;
}

/**
 * Make files with the CLI's own tools in its OS sandbox (python-pptx decks,
 * documents, charts). Whatever it saves in artifacts/ lands on the canvas.
 */
export function submitMake(mulchId: string, brief: string, options: LongOptions = {}): JobStatus {
  return enqueue(mulchId, {
    lane: "long",
    label: options.title || shorten(brief, 50),
    retry: { kind: "make", input: brief, ...options },
    near: options.near,
    async run(job, signal) {
      const started = Date.now();
      const workspace = makerWorkspace(mulchId);
      await fs.mkdir(workspace.cwd, { recursive: true });
      await fs.mkdir(workspace.writable[0], { recursive: true });
      const mulch = await getMulch(mulchId);
      await runTurn({
        mulchId,
        job,
        signal,
        lane: "command",
        systemPrompt: makerPrompt,
        prompt:
          `<mulch>\n${describeMulch(mulch, { textLimit: 2000 })}\n</mulch>\n\n` +
          `Working folder (scratch): ${workspace.cwd}\nSave finished files in: ${workspace.writable[0]}\n` +
          `Canvas files (images, documents) are in: ${path.join(mulchDir(mulchId), "assets")}\n\n${conversationBlock(await callTranscript(mulchId, { maxChars: 40_000 }))}<brief>\n${brief}\n</brief>${await relatedElsewhere(mulchId, brief)}`,
        tools: ["get_mulch", "view_image", "present_file", "preview_artifact", "say", "search_all_mulches", "read_source"],
        workspace,
        webAccess: true,
      });
      // Codex makes files without our tools, and Claude may forget one: put any new file on the canvas.
      const current = await getMulch(mulchId);
      const onMulch = new Set(Object.values(current.nodes).map((node) => node.docPath));
      const fresh = (await newArtifacts(mulchId, started)).filter((docPath) => !onMulch.has(docPath));
      for (const docPath of fresh) await addArtifactNode(mulchId, job.id, docPath, job);
    },
  });
}

async function addArtifactNode(mulchId: string, jobId: string, docPath: string, job?: JobStatus): Promise<void> {
  const mulch = await getMulch(mulchId);
  const id = newClientId("n");
  const name = path.basename(docPath);
  const size = { w: NODE_WIDTH.artifact, h: artifactHeight(docPath) };
  const held = job ? takeHeld(mulchId, job) : undefined;
  const position = placeNear(mulch, size, held ? { fallback: { x: held.x + size.w / 2, y: held.y + size.h / 2 }, seed: id } : { seed: id });
  await applyToMulch(
    mulchId,
    [{ op: "addNode", node: { id, kind: "artifact", x: position.x, y: position.y, title: name.replace(/\.[a-z0-9]+$/, "").replace(/[-_]+/g, " "), text: "", docPath, fileName: name, origin: `agent:${jobId}`, createdAt: Date.now() } }],
    `agent:${jobId}`,
  );
}

/** Look at a dropped image: caption it and add what it brings to the canvas. */
export function submitImage(mulchId: string, nodeId: string, label: string): void {
  enqueue(mulchId, {
    lane: "ingest",
    label,
    async run(job, signal) {
      const mulch = await getMulch(mulchId);
      await runTurn({
        mulchId,
        job,
        signal,
        lane: "slow",
        systemPrompt: imagePrompt,
        prompt: `<mulch>\n${describeMulch(mulch, { textLimit: 140, maxNodes: 120 })}\n</mulch>\n\nNew image: ${nodeId}`,
        tools: ["view_image", "caption_image", "add_nodes", "connect"],
      });
    },
  });
}

/** Explore a folder and build items from it. */
export function submitFolder(mulchId: string, folder: string): JobStatus {
  return enqueue(mulchId, {
    lane: "ingest",
    label: `Exploring ${folder.split("/").pop()}`,
    retry: { kind: "folder", input: folder },
    async run(job, signal) {
      await runTurn({
        mulchId,
        job,
        signal,
        lane: "command",
        systemPrompt: folderPrompt,
        prompt: `Folder: ${folder}`,
        tools: ["list_files", "find_files", "read_file", "add_nodes", "connect", "arrange", "say", "set_title"],
        readRoot: folder,
      });
    },
  });
}

export function setEnrichmentPaused(mulchId: string, paused: boolean): void {
  const entry = jobsFor(mulchId);
  entry.paused = paused;
  if (paused) for (const running of entry.running.slow) running.controller.abort();
  else pump(mulchId, "slow");
}

export function cancelJobs(mulchId: string): void {
  const entry = jobsFor(mulchId);
  entry.pendingSegments = [];
  entry.pendingEnrich = [];
  for (const lane of Object.keys(entry.queues) as JobLane[]) {
    for (const { job } of entry.queues[lane]) if (job.retry) void setJob(mulchId, { ...job, state: "cancelled", finishedAt: Date.now() });
    entry.queues[lane] = [];
  }
  for (const list of Object.values(entry.running)) for (const running of list) running.controller.abort();
}

/** Stop one job, queued or running. */
export function cancelJob(mulchId: string, jobId: string): boolean {
  const entry = jobsFor(mulchId);
  for (const lane of Object.keys(entry.queues) as JobLane[]) {
    const index = entry.queues[lane].findIndex((queued) => queued.job.id === jobId);
    if (index < 0) continue;
    const [{ job }] = entry.queues[lane].splice(index, 1);
    if (job.retry) void setJob(mulchId, { ...job, state: "cancelled", finishedAt: Date.now() });
    return true;
  }
  const running = findRunning(mulchId, jobId);
  running?.controller.abort();
  return !!running;
}

/** Start a failed or stopped job again, as a new job. */
export async function retryJob(mulchId: string, jobId: string): Promise<JobStatus | undefined> {
  const old = (await getJobs(mulchId)).find((job) => job.id === jobId);
  if (!old?.retry || old.state === "queued" || old.state === "running") return undefined;
  await setJob(mulchId, { ...old, unseen: false });
  const { kind, input, near, title } = old.retry;
  if (kind === "make") return submitMake(mulchId, input, { near, title });
  if (kind === "research") return submitResearch(mulchId, input, { near, title });
  if (kind === "folder") return submitFolder(mulchId, input);
  return submitCommand(mulchId, input);
}
