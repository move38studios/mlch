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
import type { AgentHarnessStatus, AgentUserSetup, AgentWorkspace, HarnessEvent, ToolApprovalRequest } from "@/lib/agent/types";
import type { JobLane, JobRetry, JobStatus, TranscriptSegment, ViewAction } from "@/lib/mulch/events";
import { newClientId } from "@/lib/mulch/ids";
import { checkpoint } from "@/lib/mulch/history";
import { applyToMulch, emit, focusModes, getJobs, getMulch, isQuiet, keepWhile, listMulches, mulchDir, onAfterApply, onJobChanged, openMulch, peekMulch, setJob } from "@/lib/mulch/store";
import { desktopRequest } from "@/lib/desktop/server";
import type { Mulch, MulchNode } from "@/lib/mulch/types";
import { modelFor, readSettings, type Lane, type Settings } from "@/lib/settings";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adoptArtifact } from "@/lib/artifacts/artifacts";
import { privateDirs } from "./files";
import { holdSpace, placeNear, topicBox } from "@/lib/mulch/place";
import { artifactHeight, NODE_WIDTH } from "@/lib/mulch/sizes";
import { dropEcho } from "@/lib/voice/echo";
import { CONNECTORS_NOTE, callPrompt, livePrompt, commandPrompt, earlierExchanges, fastPrompt, folderPrompt, imagePrompt, ingestPrompt, makerPrompt, researchPrompt, slowPrompt } from "./prompts";
import { onFinished, type GenerationRecord } from "@/lib/media/generations";
import { recordUsage } from "./usage";
import { search } from "@/lib/search";
import { autoSources, syncSources } from "@/lib/sources/sources";
import { cliFailed, prepareCli } from "./server/cli";
// Registers live sharing: shared canvases follow every change.
import "@/lib/share/shares";
import { exaAvailable } from "@/lib/search/exa";
import { createMulchTools, describeMulch, MAX_REVIEW_ROUNDS, type ToolContext, type ToolName } from "./tools";
import { commentNow, lastTurnAt, yourTurn } from "./turn";
import { projectBlock, projectOf } from "@/lib/projects/projects";

/** Sources longer than this are read in part; the rest is found by search. */
const LONG_SOURCE = 60_000;

/**
 * How long a job runs. The person's instructions and long work (command, long)
 * run for a period: when it ends they pause, keep what they added, and "keep
 * going" resumes the same session for another period.
 */
const PERIOD_MS = 30 * 60_000;
const TIMEOUT_MS: Record<JobLane, number> = { fast: 120_000, slow: 300_000, command: PERIOD_MS, ingest: 600_000, long: PERIOD_MS };
/** MLCH_PERIOD_MS shortens the period (tests). */
const timeoutFor = (lane: JobLane) => (PAUSING.has(lane) && Number(process.env.MLCH_PERIOD_MS)) || TIMEOUT_MS[lane];
/** Lanes whose kept jobs pause instead of failing when time or steps run out. */
const PAUSING: ReadonlySet<JobLane> = new Set(["command", "long"]);
/**
 * Model round-trips in one turn of capture, enrichment and reading, which are
 * quick by design. Instructions and long work have no step limit; their period bounds them.
 */
const QUICK_STEPS = 40;
/** The person's instructions and long work running at once in one mulch, together. */
const WORK_PER_MULCH = 10;
/**
 * …and in all mulches: each is its own Claude Code or Codex process, so the Mac
 * sets the limit. A Claude Code turn peaked at about 300 MB (measured 2026-10-18);
 * these may use about half the memory: 1.5 per GB (36 on a 24 GB Mac, at least
 * WORK_PER_MULCH). More wait as queued.
 */
const WORK_TOTAL_PER_GB = 1.5;
function workTotal(): number {
  return Number(process.env.MLCH_WORK_TOTAL) || Math.max(WORK_PER_MULCH, Math.floor((os.totalmem() / 2 ** 30) * WORK_TOTAL_PER_GB));
}
const isWork = (lane: JobLane) => lane === "command" || lane === "long";
const workRunning = (entry: MulchJobs) => entry.running.command.length + entry.running.long.length;
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
  /** The speech or typing it came from. */
  inputIds?: string[];
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
  /** A spoken instruction waiting for the person to finish (speech cut at a pause can end mid-sentence). */
  spoken?: { instruction: string; from: string[]; after: TranscriptSegment[]; startedAt: number; timer?: ReturnType<typeof setTimeout> };
  /** Slow lane: new item ids not yet enriched. */
  pendingEnrich: string[];
  paused: boolean;
  /** A call is being listened to: speech is captured in batches every CALL_BATCH_MS. */
  call?: {
    segments: TranscriptSegment[];
    timer?: ReturnType<typeof setTimeout>;
    startedAt: number;
    /** The transcript card, filled in as the call goes. */
    transcriptId?: string;
    cardTimer?: ReturnType<typeof setTimeout>;
    /** Topic areas (group ids) in order; the last is where new cards go. */
    topics: string[];
    /** The decisions and to-dos card, and its lines. */
    decisionsId?: string;
    decisions: string[];
    /** Changes to the topics and the decisions card, one at a time. */
    chain: Promise<unknown>;
    /** The live layer: when it last ran, up to which speech it has seen, its next run. */
    live: { lastAt: number; seenUntil: number; timer?: ReturnType<typeof setTimeout> };
  };
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
  /** During a call: its topic areas and decisions card (cards added go into the current topic). */
  call?: ToolContext["call"];
  /**
   * The person's own Claude Code / Codex setup and connectors (Settings → AI). Only for
   * work they asked for: capture and enrichment run on everything said, so they stay quick
   * (the setup adds seconds per turn) and never act unasked.
   */
  ownSetup?: boolean;
}

/* ── connector approvals ──────────────────────────────────────── */

const APPROVAL_TEXT_LIMIT = 2_000;

/** Arguments as the card shows them: long strings cut, nested values as JSON. */
function approvalInput(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input)
      .slice(0, 20)
      .map(([key, value]) => {
        const text =
          typeof value === "string" ? value : Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join(", ") : (JSON.stringify(value) ?? "");
        return [key, text.length > APPROVAL_TEXT_LIMIT ? `${text.slice(0, APPROVAL_TEXT_LIMIT)}…` : text];
      }),
  );
}

const pendingApprovals = ((globalThis as typeof globalThis & { __mlchApprovals?: Map<string, (allow: boolean) => void> }).__mlchApprovals ??= new Map());

/**
 * Ask the person about a connector tool that acts: the job shows a card in the
 * conversation, the turn waits for Allow or Deny. Stopping the job denies.
 */
function askApproval(mulchId: string, job: JobStatus, request: ToolApprovalRequest, signal: AbortSignal): Promise<boolean> {
  const id = newClientId("a");
  return new Promise((resolve) => {
    const finish = (allow: boolean) => {
      if (!pendingApprovals.delete(id)) return;
      signal.removeEventListener("abort", onAbort);
      job.approvals = (job.approvals ?? []).filter((approval) => approval.id !== id);
      if (!job.approvals.length) delete job.approvals;
      void setJob(mulchId, { ...job }).catch(() => {});
      log.info("agent", allow ? "connector tool allowed" : "connector tool denied", { mulchId, jobId: job.id, server: request.server, tool: request.tool });
      resolve(allow);
    };
    const onAbort = () => finish(false);
    pendingApprovals.set(id, finish);
    signal.addEventListener("abort", onAbort, { once: true });
    job.approvals = [...(job.approvals ?? []), { id, server: request.server, tool: request.tool, input: approvalInput(request.input), at: Date.now() }];
    void setJob(mulchId, { ...job }).catch(() => {});
    log.info("agent", "connector tool waiting for the person", { mulchId, jobId: job.id, server: request.server, tool: request.tool });
  });
}

/** The person's answer to a connector tool card. False when nothing is waiting under that id. */
export function answerApproval(approvalId: string, allow: boolean): boolean {
  const finish = pendingApprovals.get(approvalId);
  if (!finish) return false;
  finish(allow);
  return true;
}

class JobError extends Error {}
/** The turn used all its steps: the work is unfinished, not broken. */
class OutOfSteps extends JobError {}

/** Paused jobs being continued: the session their next turn resumes (absent when there is none to resume). */
const resuming = new Map<string, JobStatus["session"] | null>();

/** The first turn of a continued job: the same session told to keep going, or the original prompt told what it already did. */
function continuation(spec: TurnSpec, harness: string): { prompt: string; sessionId?: string } | undefined {
  if (!resuming.has(spec.job.id)) return undefined;
  const session = resuming.get(spec.job.id);
  resuming.delete(spec.job.id);
  const added = (spec.job.resultIds ?? []).join(", ");
  const done = added ? `What you added so far is on the canvas (${added}).` : "Nothing was added to the canvas yet.";
  if (session && session.harness === harness) {
    // The request again, in case the vendor no longer has the session and it starts fresh.
    return {
      sessionId: session.id,
      prompt: `Your time ran out and the person asked you to keep going. ${done} Pick up where you stopped and finish; do not redo what is done.\n\n<request>\n${spec.job.retry?.input ?? spec.job.label}\n</request>`,
    };
  }
  return { prompt: `You started on this before and your time ran out. ${done} Continue from there; do not redo what is done.\n\n${spec.prompt}` };
}

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
    default: {
      // The person's connectors: mcp__claude_ai_Gmail__search_threads → "Gmail: search threads".
      const mcp = name.match(/^mcp__(.+?)__(.+)$/);
      if (!mcp) return undefined;
      return `${mcp[1].replace(/^claude_ai_/, "").replace(/_/g, " ")}: ${mcp[2].replace(/_/g, " ")}`;
    }
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
    // Only the person's own instructions and long work (kept jobs) can leave a message.
    ...(spec.job.retry
      ? {
          onMessage: (text: string) => {
            spec.job.message = { text, at: Date.now() };
            void setJob(spec.mulchId, { ...spec.job }).catch(() => {});
          },
        }
      : {}),
    origin: spec.origin,
    brief: spec.brief,
    reviewRound: spec.reviewRound,
    sources: spec.sources,
    call: spec.call,
    session: { id: spec.sessionId } as { id?: string },
    added: [] as string[],
  };
  const harness = getHarness(settings.harness);
  const continued = continuation(spec, settings.harness);
  const sessionId = continued ? continued.sessionId : spec.sessionId;
  const userSetup: AgentUserSetup | undefined =
    spec.ownSetup && settings.agentSetup
      ? { connectors: true, approve: (request) => askApproval(spec.mulchId, spec.job, request, spec.signal) }
      : undefined;
  // The person's work runs as their own CLI does (Settings → AI, Permissions), with their setup.
  const access = userSetup && settings.access !== "sandboxed" ? settings.access : undefined;
  const cwd = access ? (spec.workspace?.cwd ?? path.join(mulchDir(spec.mulchId), "work")) : undefined;
  if (cwd) await fs.mkdir(cwd, { recursive: true }).catch(() => {});
  const events: AsyncIterable<HarnessEvent> = harness.runTurn({
    ...(access ? { access, cwd } : {}),
    ...(sessionId ? { sessionId } : {}),
    history: [],
    prompt: continued?.prompt ?? spec.prompt,
    systemPrompt: (typeof spec.systemPrompt === "string" ? spec.systemPrompt : spec.systemPrompt(settings)) + (userSetup ? CONNECTORS_NOTE : ""),
    tools: createMulchTools(ctx),
    model: modelFor(settings, spec.lane),
    ...(PAUSING.has(spec.job.lane) ? {} : { maxSteps: QUICK_STEPS }),
    webAccess: spec.webAccess,
    workspace: spec.workspace,
    userSetup,
    signal: spec.signal,
  });
  // The model's own words, sentence by sentence, are the best "what it is doing now".
  const said = new Map<string, string>();
  for await (const event of events) {
    if (event.type === "session") {
      ctx.session.id = event.sessionId;
      // Kept so a paused job can resume it.
      spec.job.session = { id: event.sessionId, harness: settings.harness };
    }
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
      if (event.code === "step_limit") throw new OutOfSteps(event.message);
      // The CLI itself broke (not a refusal, nor a turn stopped for time): if it was the person's own install, use the tested version next time.
      if (!spec.signal.aborted && (event.code === "harness_error" || event.code === "not_installed")) cliFailed(settings.harness);
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

/** Quiet holds what the AI would do unasked: enrichment, and digesting dropped files (not the person's own work). */
function held(mulchId: string, queued: Queued): boolean {
  if (!isQuiet(mulchId)) return false;
  return queued.work.lane === "slow" || (queued.work.lane === "ingest" && !queued.work.retry);
}

function canStart(mulchId: string, lane: JobLane): boolean {
  const entry = jobsFor(mulchId);
  if (!isWork(lane)) return entry.running[lane].length === 0;
  if (workRunning(entry) >= WORK_PER_MULCH) return false;
  let total = 0;
  for (const other of state().mulches.values()) total += workRunning(other);
  return total < workTotal();
}

function pump(mulchId: string, lane: JobLane): void {
  const entry = jobsFor(mulchId);
  for (;;) {
    const index = entry.queues[lane].findIndex((queued) => !held(mulchId, queued));
    if (index < 0 || !canStart(mulchId, lane)) return;
    start(mulchId, entry.queues[lane].splice(index, 1)[0]);
  }
}

/** A slot for instructions and long work came free: any mulch may use it. */
function pumpWork(): void {
  for (const mulchId of state().mulches.keys()) {
    pump(mulchId, "command");
    pump(mulchId, "long");
  }
}

function start(mulchId: string, { work, job }: Queued): void {
  const entry = jobsFor(mulchId);
  const lane = work.lane;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Timed out")), timeoutFor(lane));
  const running: Running = { job, controller };
  entry.running[lane].push(running);
  const timedOut = () => controller.signal.reason instanceof Error && controller.signal.reason.message === "Timed out";
  // The person's own work keeps what it did and waits for "keep going".
  const pauses = !!work.retry && PAUSING.has(lane);
  const pause = async (why: "time" | "steps") => {
    log.info("jobs", "job paused", { mulchId, jobId: job.id, lane, why, ms: Date.now() - (job.startedAt ?? Date.now()), session: !!job.session });
    await update(mulchId, job, { state: "paused", finishedAt: Date.now(), activity: undefined, anchor: undefined, approvals: undefined });
  };
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
      if (timedOut() && pauses) return await pause("time");
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
      if (pauses && (timedOut() || error instanceof OutOfSteps)) return await pause(timedOut() ? "time" : "steps").catch(() => {});
      const cancelled = controller.signal.aborted && !timedOut();
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
      if (isWork(lane)) pumpWork();
    }
  })();
}

/** Queue work without starting it; returns its job (`again`: a paused job carried on). */
function queue(mulchId: string, work: Work, again?: JobStatus): JobStatus {
  const job: JobStatus = again ?? { id: newClientId("j"), lane: work.lane, state: "queued", label: work.label, queuedAt: Date.now(), ...(work.retry ? { retry: work.retry } : {}), ...(work.inputIds?.length ? { inputIds: work.inputIds } : {}) };
  jobsFor(mulchId).queues[work.lane].push({ work, job });
  // Only the person's own requests are worth showing while they wait.
  if (work.retry) void setJob(mulchId, { ...job }).catch(() => {});
  return job;
}

function enqueue(mulchId: string, work: Work, again?: JobStatus): JobStatus {
  const job = queue(mulchId, work, again);
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

/**
 * Start or stop call capture for a mulch (the system-audio capture starts and stops it).
 * A call gets a transcript card, filled in as it goes; stopping captures what is left,
 * finishes the transcript and writes the notes.
 */
export function setCallMode(mulchId: string, on: boolean): void {
  const entry = jobsFor(mulchId);
  if (on) {
    if (entry.call) return;
    const startedAt = Date.now();
    entry.call = { segments: [], startedAt, topics: [], decisions: [], chain: Promise.resolve(), live: { lastAt: 0, seenUntil: startedAt } };
    void startCallCard(mulchId, entry.call).catch((error) => log.warn("jobs", "call transcript card failed", { mulchId, error }));
    return;
  }
  const call = entry.call;
  if (!call) return;
  clearTimeout(call.timer);
  clearTimeout(call.cardTimer);
  clearTimeout(call.live.timer);
  const rest = call.segments.splice(0);
  entry.call = undefined;
  if (rest.length) captureCall(mulchId, rest, call);
  void endCall(mulchId, call, Date.now()).catch((error) => log.warn("jobs", "finishing a call failed", { mulchId, error }));
}

/* ── the call's transcript and notes ───────────────────────────── */

const CALL_CARD_MS = 15_000;

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function callHeading(startedAt: number, endedAt?: number): string {
  const day = new Date(startedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  if (endedAt === undefined) return `Call, ${day}, ${clockTime(startedAt)}`;
  const minutes = Math.round((endedAt - startedAt) / 60_000);
  if (minutes < 1) return `Call, ${day}, ${clockTime(startedAt)} (under a minute)`;
  return `Call, ${day}, ${clockTime(startedAt)} to ${clockTime(endedAt)} (${minutes} min)`;
}

/** The call so far as markdown: who spoke when, consecutive lines of one speaker together. The heading is the card's title. */
export function callMarkdown(segments: TranscriptSegment[], startedAt: number, endedAt?: number): string {
  const lines: string[] = [];
  let last: { speaker?: string; text: string[]; at: number } | undefined;
  const flush = () => {
    if (last) lines.push(`${last.speaker ? `**${last.speaker === "me" ? "Me" : "Them"}** ` : ""}(${clockTime(last.at)}) ${last.text.join(" ")}`, "");
  };
  for (const segment of segments) {
    if (last && last.speaker === segment.speaker) last.text.push(segment.text.trim());
    else {
      flush();
      last = { speaker: segment.speaker, text: [segment.text.trim()], at: segment.at };
    }
  }
  flush();
  if (!segments.length) lines.push(endedAt === undefined ? "Listening." : "Nothing was heard.");
  return lines.join("\n").trim();
}

async function callSegments(mulchId: string, startedAt: number, endedAt = Infinity): Promise<TranscriptSegment[]> {
  const transcript = (await openMulch(mulchId)).transcript;
  // Speech only; without the Mac's sound (no permission) the microphone's has no speaker.
  return dropEcho(transcript.filter((segment) => segment.source === "speech" && segment.at >= startedAt - 1000 && segment.at <= endedAt));
}

async function startCallCard(mulchId: string, call: NonNullable<MulchJobs["call"]>): Promise<void> {
  const mulch = await getMulch(mulchId);
  const id = newClientId("n");
  const stamp = new Date(call.startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const docPath = `docs/call-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.md`;
  const at = placeNear(mulch, { w: NODE_WIDTH.writeup, h: 260 }, { seed: id });
  const text = callMarkdown([], call.startedAt);
  // The person's own words: the AI may not change it.
  await applyToMulch(mulchId, [{ op: "addNode", node: { id, kind: "writeup", x: at.x, y: at.y, title: callHeading(call.startedAt), text, docPath, origin: "speech:call", createdAt: Date.now() } }], "speech:call");
  call.transcriptId = id;
}

/** Refresh the transcript card soon (every CALL_CARD_MS at most while speech comes in). */
function touchCallCard(mulchId: string): void {
  const call = jobsFor(mulchId).call;
  if (!call || call.cardTimer) return;
  call.cardTimer = setTimeout(() => {
    call.cardTimer = undefined;
    void writeCallCard(mulchId, call).catch((error) => log.warn("jobs", "updating the call transcript failed", { mulchId, error }));
  }, CALL_CARD_MS);
}

async function writeCallCard(mulchId: string, call: NonNullable<MulchJobs["call"]>, endedAt?: number): Promise<TranscriptSegment[]> {
  const segments = await callSegments(mulchId, call.startedAt, endedAt);
  const id = call.transcriptId;
  const node = id ? (await getMulch(mulchId)).nodes[id] : undefined;
  // The person may have removed the card; then the transcript stays in the mulch's history only.
  if (id && node) {
    const text = callMarkdown(segments, call.startedAt, endedAt);
    if (text !== node.text) await applyToMulch(mulchId, [{ op: "updateNode", id, patch: { text, title: callHeading(call.startedAt, endedAt), updatedAt: Date.now() } }], "speech:call");
  }
  return segments;
}

async function endCall(mulchId: string, call: NonNullable<MulchJobs["call"]>, endedAt: number): Promise<void> {
  // The last chunks are still being transcribed for a moment after stopping.
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.MLCH_CALL_SETTLE_MS) || 4000));
  const segments = await writeCallCard(mulchId, call, endedAt);
  if (!segments.length) {
    // Nothing was said: no card left behind.
    if (call.transcriptId) await applyToMulch(mulchId, [{ op: "removeNode", id: call.transcriptId }], "speech:call");
    return;
  }
  submitCallNotes(mulchId, { startedAt: call.startedAt, endedAt, transcriptId: call.transcriptId });
  // Topic areas nothing went into are dropped; the rest are tidied with the call's points.
  const mulch = await getMulch(mulchId);
  const empty = call.topics.filter((id) => mulch.groups[id] && !Object.values(mulch.nodes).some((node) => node.groupId === id));
  if (empty.length) await applyToMulch(mulchId, empty.map((id) => ({ op: "removeGroup" as const, id })), "agent:call");
  submitCallTidy(mulchId, { startedAt: call.startedAt, endedAt, transcriptId: call.transcriptId, decisionsId: call.decisionsId, topics: call.topics.filter((id) => !empty.includes(id)) });
}

interface CallFacts {
  startedAt: number;
  endedAt: number;
  transcriptId?: string;
  decisionsId?: string;
  topics?: string[];
}

/**
 * After a call: its main points as cards in their topics (what was said, in
 * its words), the open questions people asked together, repeats among the
 * AI's cards merged, related cards connected across topics.
 */
export function submitCallTidy(mulchId: string, call: CallFacts, again?: JobStatus): JobStatus {
  return enqueue(mulchId, {
    lane: "command",
    label: "Tidying the call",
    retry: { kind: "callTidy", input: JSON.stringify(call) },
    async run(job, signal) {
      const segments = await callSegments(mulchId, call.startedAt, call.endedAt);
      if (!segments.length) return;
      const transcript = segments.map((s) => `${s.speaker ? `[${s.speaker}] ` : ""}(${clockTime(s.at)}) ${s.text.trim()}`).join("\n");
      const clipped = transcript.length > 150_000 ? `${transcript.slice(0, 75_000)}\n…\n${transcript.slice(-75_000)}` : transcript;
      const mulch = await getMulch(mulchId);
      const topics = (call.topics ?? []).filter((id) => mulch.groups[id]).map((id) => `${id} "${mulch.groups[id].title}"`);
      await runTurn({
        mulchId,
        job,
        signal,
        lane: "command",
        systemPrompt: commandPrompt,
        prompt:
          (await contextBlock(mulchId)) +
          `<mulch>\n${await mulchContext(mulchId, clipped.slice(-4000), 300)}\n</mulch>\n\n` +
          `<call>\n${callHeading(call.startedAt, call.endedAt)}\n[me] is the person using mlch, [them] the others.\n\n${clipped}\n</call>\n\n` +
          `<instruction>\nThe call has ended (its transcript is ${call.transcriptId ?? "kept"}${call.decisionsId ? `, its decisions and to-dos are ${call.decisionsId}` : ""}; notes are being written separately). Make the board something to think with afterwards:\n` +
          `1. The call's main points as cards, in the speakers' words trimmed: \`idea\` (under 30 words; who, where it matters: "Me", a name when it was said, else "they"), and \`question\` only for questions someone actually asked that stayed open. Specific claims, numbers, names and disagreements; not small talk, not what the decisions card or the board already has. Usually 3-8 per subject.\n` +
          (topics.length ? `   Put each in the topic area it belongs to with \`group\`: ${topics.join(", ")}.\n` : "   Put related points near each other.\n") +
          "2. Where your own cards from during the call (the AI's, not the person's) repeat each other, keep the best and remove the rest.\n" +
          "3. Connect cards across topics where the label says something (\"contradicts\", \"answers\", \"leads to\").\n" +
          "4. arrange everything from the call into labelled groups: the topics (their titles, merging ones the call came back to), and one group \"Open questions\" for the open questions. Leave the transcript, the decisions card and anything from before the call where they are.\n" +
          "Never reword or remove what the person made. Write in the language of the call. Finish with say.\n</instruction>",
        tools: ["get_mulch", "add_nodes", "connect", "remove_nodes", "arrange", "say"],
        origin: `speech:${job.id}`,
        allowUserEdits: true,
        brief: "Tidy the call",
      });
    },
  }, again);
}

/** The notes of a finished call: summary, decisions, to-dos, open questions, next to its transcript. */
export function submitCallNotes(mulchId: string, call: { startedAt: number; endedAt: number; transcriptId?: string }, again?: JobStatus): JobStatus {
  return enqueue(mulchId, {
    lane: "command",
    label: "Call notes",
    retry: { kind: "callNotes", input: JSON.stringify(call) },
    async run(job, signal) {
      const segments = await callSegments(mulchId, call.startedAt, call.endedAt);
      const transcript = segments.map((s) => `${s.speaker ? `[${s.speaker}] ` : ""}(${clockTime(s.at)}) ${s.text.trim()}`).join("\n");
      const clipped = transcript.length > 150_000 ? `${transcript.slice(0, 75_000)}\n…\n${transcript.slice(-75_000)}` : transcript;
      const made = Object.values((await getMulch(mulchId)).nodes)
        .filter((node) => node.createdAt >= call.startedAt && node.createdAt <= call.endedAt + 120_000 && node.id !== call.transcriptId)
        .map((node) => `${node.id}: ${node.title ? `${node.title}: ` : ""}${shorten(node.text, 120)}`);
      await runTurn({
        mulchId,
        job,
        signal,
        lane: "command",
        systemPrompt: commandPrompt,
        prompt:
          `<call>\n${callHeading(call.startedAt, call.endedAt)}\n[me] is the person using mlch, [them] the others.\n\n${clipped}\n</call>\n\n` +
          (made.length ? `<made_during_the_call>\n${made.join("\n")}\n</made_during_the_call>\n\n` : "") +
          `<instruction>\nThe call has ended. Write its notes with write_doc, titled "Notes: ${callHeading(call.startedAt, call.endedAt)}", near ${call.transcriptId ?? "the newest items"}. ` +
          "Sections: a short summary (3-6 lines); Decisions; To-dos (who, what, by when if said); Open questions. Leave out a section with nothing in it. " +
          "Only what was said. Say who where it matters: \"Me\" for [me], the person's name when it was said, else \"them\"; never the bracket tags. Write in the language of the call. " +
          `${call.transcriptId ? `Connect the notes to the transcript ${call.transcriptId} (label "notes of"). ` : ""}Do not add other items. Finish with say.\n</instruction>`,
        tools: ["write_doc", "connect", "say", "cold_read"],
        brief: "Call notes",
        ownSetup: true,
      });
    },
  }, again);
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

/** The call's topic areas and decisions card, as tools see them. */
function callTools(mulchId: string, call = jobsFor(mulchId).call): ToolContext["call"] {
  if (!call) return undefined;
  const serial = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = call.chain.then(work, work);
    call.chain = next.catch(() => {});
    return next;
  };
  return {
    current: () => call.topics.at(-1),
    topic: (title) =>
      serial(async () => {
        const mulch = await getMulch(mulchId);
        const before = call.topics.filter((id) => mulch.groups[id]).at(-1);
        const box = topicBox(mulch, { after: before, near: [call.transcriptId, call.decisionsId].filter((id): id is string => !!id && !!mulch.nodes[id]) });
        const id = newClientId("g");
        await applyToMulch(mulchId, [{ op: "addGroup", group: { id, title: title.slice(0, 80), ...box, origin: "agent:call", createdAt: Date.now() } }], "agent:call");
        call.topics.push(id);
        return id;
      }),
    note: (kind, text) =>
      serial(async () => {
        call.decisions.push(`- ${kind === "decision" ? "Decision" : "To do"}: ${text.replace(/\s+/g, " ")}`);
        const body = call.decisions.join("\n");
        const mulch = await getMulch(mulchId);
        const card = call.decisionsId ? mulch.nodes[call.decisionsId] : undefined;
        if (card) {
          await applyToMulch(mulchId, [{ op: "updateNode", id: card.id, patch: { text: body, updatedAt: Date.now() } }], "agent:call");
          return;
        }
        const id = newClientId("n");
        const at = placeNear(mulch, { w: NODE_WIDTH.writeup, h: 200 }, { anchorIds: call.transcriptId && mulch.nodes[call.transcriptId] ? [call.transcriptId] : [], seed: id });
        await applyToMulch(mulchId, [{ op: "addNode", node: { id, kind: "writeup", x: at.x, y: at.y, title: DECISIONS_TITLE, text: body, origin: "agent:call", createdAt: Date.now() } }], "agent:call");
        call.decisionsId = id;
      }),
  };
}

/** Placeholder wording (George). */
const DECISIONS_TITLE = "Decisions and to-dos";

/** What the call has so far, for the record's prompt: its topics and decisions. */
async function callSoFar(mulchId: string, call = jobsFor(mulchId).call): Promise<string> {
  if (!call) return "";
  const mulch = await getMulch(mulchId);
  const topics = call.topics.map((id) => mulch.groups[id]?.title).filter(Boolean);
  return (
    (topics.length ? `<topics>\n${topics.map((t, i) => `${i + 1}. ${t}${i === topics.length - 1 ? " (current)" : ""}`).join("\n")}\n</topics>\n\n` : "<topics>\nNone yet.\n</topics>\n\n") +
    (call.decisions.length ? `<decisions_and_todos>\n${call.decisions.join("\n")}\n</decisions_and_todos>\n\n` : "")
  );
}

/** The project and words for a prompt (empty when neither). */
function contextBlock(mulchId: string): Promise<string> {
  return projectBlock(mulchId, async (id) => (await peekMulch(id))?.title).catch(() => "");
}

/**
 * The record of a call, every batch: decisions and to-dos, topics, and
 * instructions from [me]. No cards from speech: what was said is kept in the
 * transcript and turned into cards when the call ends.
 */
function captureCall(mulchId: string, raw: TranscriptSegment[], call = jobsFor(mulchId).call): void {
  const segments = dropEcho(raw);
  const text = inputBlock(segments);
  if (!text) return;
  enqueue(mulchId, {
    lane: "fast",
    label: "Listening",
    inputIds: segments.map((segment) => segment.id),
    async run(job, signal) {
      const mulch = await getMulch(mulchId);
      const live = !isQuiet(mulchId);
      await runTurn({
        mulchId,
        job,
        signal,
        lane: "fast",
        systemPrompt: callPrompt,
        prompt:
          (await contextBlock(mulchId)) +
          (await callSoFar(mulchId, call)) +
          `<call_so_far>\n${await callTranscript(mulchId, { minutes: 6, before: segments[0]?.at })}\n</call_so_far>\n\n<new_conversation>\n${text}\n</new_conversation>`,
        tools: ["call_note", "hand_off", "focus", "view", ...(live ? (["call_topic"] as const) : []), ...(mulch.title === "Untitled" ? (["set_title"] as const) : [])],
        origin: `speech:${job.id}`,
        // The last batch is captured after the call stops: it still belongs to that call.
        call: callTools(mulchId, call),
        onHandOff: (instruction) => submitCommand(mulchId, instruction, { inputIds: segments.map((segment) => segment.id) }),
      });
    },
  });
}

/** The live layer runs at most this often during a call, and looks back this far. */
const LIVE_EVERY_MS = Number(process.env.MLCH_LIVE_EVERY_MS) || 60_000;
/** The first run waits for the record's first batch, which names the first topic. */
const LIVE_FIRST_MS = Number(process.env.MLCH_LIVE_FIRST_MS) || CALL_BATCH_MS + 15_000;
const LIVE_WINDOW_MS = 150_000;

/** New speech in a call: the live layer runs soon (at most once a minute), unless the mulch is Quiet. */
function armLive(mulchId: string): void {
  const call = jobsFor(mulchId).call;
  if (!call || call.live.timer || isQuiet(mulchId)) return;
  const wait = Math.max(LIVE_FIRST_MS, call.live.lastAt + LIVE_EVERY_MS - Date.now());
  call.live.timer = setTimeout(() => {
    call.live.timer = undefined;
    if (jobsFor(mulchId).call !== call) return;
    submitLive(mulchId);
  }, wait);
}

/**
 * The live layer: what would help the conversation right now (a book's page,
 * an answer, a definition, a source, a link to the person's own material),
 * from the last minute or two, into the current topic. Nothing is fine.
 */
function submitLive(mulchId: string): void {
  const entry = jobsFor(mulchId);
  // One at a time: a queued one will see the newest speech when it starts.
  if (entry.queues.slow.some((queued) => queued.job.label === "Live") || entry.running.slow.some((running) => running.job.label === "Live")) return;
  queue(mulchId, {
    lane: "slow",
    label: "Live",
    async run(job, signal) {
      const call = jobsFor(mulchId).call;
      if (!call || isQuiet(mulchId)) return;
      const now = Date.now();
      call.live.lastAt = now;
      // Without the Mac's sound (no permission) speech has no speaker.
      const spoken = (await openMulch(mulchId)).transcript.filter((segment) => segment.source === "speech" && segment.at >= call.startedAt);
      // Only what is new and still recent: a moment that has passed is left.
      const since = Math.max(call.live.seenUntil, now - LIVE_WINDOW_MS);
      const fresh = dropEcho(spoken.filter((segment) => segment.at > since));
      if (!fresh.length) return;
      call.live.seenUntil = Math.max(...fresh.map((segment) => segment.at));
      const line = (s: TranscriptSegment) => `${s.speaker ? `[${s.speaker}] ` : ""}${s.text.trim()}`;
      const before = spoken.filter((segment) => segment.at <= since && segment.at > since - 6 * 60_000).map(line).join("\n");
      const settings = await readSettings();
      const web = settings.enrich.includes("search");
      const mine = settings.enrich.includes("mulches");
      const said = fresh.map(line).join("\n");
      const mulch = await getMulch(mulchId);
      const topics = call.topics.filter((id) => mulch.groups[id]);
      const added = await runTurn({
        mulchId,
        job,
        signal,
        lane: "slow",
        systemPrompt: livePrompt,
        prompt:
          (await contextBlock(mulchId)) +
          `<board>\n${await mulchContext(mulchId, said, 80)}\n</board>\n\n` +
          (topics.length
            ? `<topics>\nThe call's topic areas, in order (the last is the current one). Put each card in the area of the moment it is about, with \`group\`:\n${topics.map((id) => `${id} "${mulch.groups[id].title}"`).join("\n")}\n</topics>\n\n`
            : "") +
          (before ? `<before>\n${before}\n</before>\n\n` : "") +
          `<new>\n${said}\n</new>` +
          (mine ? await relatedElsewhere(mulchId, said.slice(0, 1000)) : ""),
        tools: [
          "add_nodes", "connect",
          ...(mine ? (["search_all_mulches", "read_source", "link_to"] as ToolName[]) : []),
          ...(web && exaAvailable() ? (["exa_search"] as ToolName[]) : []),
        ],
        webAccess: web,
        call: callTools(mulchId),
      });
      if (added.length) log.info("jobs", "Live cards", { mulchId, jobId: job.id, count: added.length });
    },
  });
  pump(mulchId, "slow");
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
    touchCallCard(mulchId);
    armLive(mulchId);
    return;
  }
  // While a spoken instruction waits, more speech goes with it.
  if (entry.spoken && segment.source === "speech") {
    entry.spoken.after.push(segment);
    armSpoken(mulchId);
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
      job.inputIds = segments.map((segment) => segment.id);
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
        onHandOff: (instruction) =>
          segments.some((segment) => segment.source === "speech") ? submitSpokenCommand(mulchId, instruction, segments) : submitCommand(mulchId, instruction, { inputIds: segments.map((segment) => segment.id) }),
      });
      if (added.length) requestEnrichment(mulchId, added);
    },
  });
}

/** How long a spoken instruction waits for more speech, and at most in all. */
const SPOKEN_SETTLE_MS = Number(process.env.MLCH_SPOKEN_SETTLE_MS) || 4000;
const SPOKEN_MAX_MS = 20_000;

/**
 * A spoken instruction runs once the person stops talking: speech arriving in
 * the meantime (the rest of a sentence cut at a pause, or more detail) goes
 * with it instead of being captured on its own.
 */
function submitSpokenCommand(mulchId: string, instruction: string, from: TranscriptSegment[]): void {
  const entry = jobsFor(mulchId);
  if (entry.spoken) entry.spoken.instruction += `\n${instruction}`;
  else entry.spoken = { instruction, from: [], after: [], startedAt: Date.now() };
  entry.spoken.from.push(...from.map((segment) => segment.id));
  // Speech already waiting for capture came after the instruction: it belongs to it.
  entry.spoken.after.push(...entry.pendingSegments.splice(0).filter((segment) => segment.source === "speech"));
  armSpoken(mulchId);
}

function armSpoken(mulchId: string): void {
  const spoken = jobsFor(mulchId).spoken;
  if (!spoken) return;
  clearTimeout(spoken.timer);
  const wait = Math.max(0, Math.min(SPOKEN_SETTLE_MS, spoken.startedAt + SPOKEN_MAX_MS - Date.now()));
  spoken.timer = setTimeout(() => releaseSpoken(mulchId), wait);
}

function releaseSpoken(mulchId: string): void {
  const entry = jobsFor(mulchId);
  const spoken = entry.spoken;
  if (!spoken) return;
  entry.spoken = undefined;
  const said = spoken.after.map((segment) => segment.text.trim()).filter(Boolean).join(" ");
  submitCommand(
    mulchId,
    said ? `${spoken.instruction}\n\nThey went on (this may finish or change the instruction; anything else is thinking to capture as items): "${said}"` : spoken.instruction,
    { inputIds: [...spoken.from, ...spoken.after.map((segment) => segment.id)] },
  );
}

export function requestEnrichment(mulchId: string, ids: string[]): void {
  // Quiet: nothing is added unasked, and going Live again doesn't catch up on it.
  if (isQuiet(mulchId)) return;
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
          (await contextBlock(mulchId)) +
          `<mulch>\n${await mulchContext(mulchId, about, 160)}\n</mulch>\n\n<new_items>\n${items.map((n) => `${n.id} ${saidByPerson(n) ? "(said)" : "(source)"}: ${n.title ? `${n.title} — ` : ""}${n.text}`).join("\n")}\n</new_items>` +
          (inCall(mulchId) ? "\n\nThis is a live call: at most 2 items; prefer facts that settle a claim made, or a question [me] could ask next." : "") +
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

/** The person's own words (typed, said, or touched since), as opposed to material from a document or link. */
function saidByPerson(node: MulchNode): boolean {
  return node.origin === "user" || node.origin.startsWith("speech:") || !!node.userTouched;
}

const COMMAND_TOOLS: ToolName[] = [
  "get_mulch", "add_nodes", "connect", "update_node", "remove_nodes", "arrange", "write_doc", "say", "tell", "add_file",
  "write_artifact", "preview_artifact", "make_pptx", "make", "view_image", "caption_image", "list_files", "find_files", "read_file",
  "media_search", "media_schema", "media_generate", "media_wait", "media_view",
  "search_mulch", "search_all_mulches", "read_source", "focus", "view", "bring_in", "link_to", "save_note", "research", "read_page", "cold_read", "screenshot_page", "resolve_comment",
  "remember_word",
];

const RESEARCH_TOOLS: ToolName[] = [
  "read_page", "add_nodes", "connect", "arrange", "write_artifact", "preview_artifact", "write_doc", "say", "tell", "add_file", "get_mulch", "search_mulch",
  "search_all_mulches", "read_source", "link_to", "cold_read", "screenshot_page",
];

/**
 * A research job: many searches and reading, then sources, a comparison table
 * and a write-up on the canvas. If the turn ends without the table or the
 * write-up, the same session is resumed once with what is missing.
 */
export function submitResearch(mulchId: string, brief: string, options: LongOptions = {}, again?: JobStatus): JobStatus {
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
        ownSetup: true,
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
        // Any sources at all: the brief decides how many (a literature question wants fewer, deeper ones).
        outcome.sources < 1 ? "sources (search items for what you found, read their pages)" : "",
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
  }, again);
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
    const limit = options.limit ?? 6;
    // The same project's mulches first.
    const project = await projectOf(mulchId).catch(() => undefined);
    const siblings = new Set(project ? others.filter((m) => m.project === project.id).map((m) => m.id) : []);
    const near = siblings.size ? await search(about, { mulchIds: [...siblings], limit: Math.ceil(limit / 2) }) : [];
    const wide = await search(about, { mulchIds: others.map((m) => m.id), sources: sources.map((s) => s.id), limit });
    const seen = new Set<string>();
    const hits = [...near, ...wide].filter((hit) => {
      const key = `${hit.mulchId}:${hit.sourceId ?? ""}:${hit.nodeId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit + near.length);
    if (!hits.length) return "";
    const lines = hits.map((hit) =>
      hit.sourceId
        ? `folder ${hit.sourceId} "${names.get(hit.sourceId) ?? ""}" · file ${hit.path}: ${hit.snippet}`
        : `mulch ${hit.mulchId} "${titles.get(hit.mulchId) ?? ""}"${siblings.has(hit.mulchId) ? " (same project)" : ""} · item ${hit.nodeId} [${hit.kind}]${hit.title ? ` "${hit.title}"` : ""}: ${hit.snippet}`,
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
      // Empty notes say nothing to name it by.
      const filled = mulch ? Object.values(mulch.nodes).filter((node) => node.text.trim() || node.title || node.assetId || node.docPath || node.url || node.ref) : [];
      if (!mulch || mulch.title !== "Untitled" || filled.length < 2) {
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

/** Jobs (and connector cards) already announced, so each is announced once. */
const announced = new Set<string>();
/** Jobs that ran in this process: an old job touched again (seen, retried) is never announced. */
const ranHere = new Set<string>();
let activityTimer: ReturnType<typeof setTimeout> | undefined;

function notify(mulchId: string, note: { ids?: string[]; title: string; body?: string; failed?: boolean }): void {
  void Promise.all([getMulch(mulchId), focusModes()])
    // Mulches in focus mode: while one is open, main holds back notifications from the others.
    .then(([mulch, focus]) => desktopRequest("notify", { mulchId, ids: note.ids ?? [], title: note.title, body: note.body ?? mulch.title, failed: !!note.failed, quietIn: [...focus].slice(0, 200) }))
    .catch(() => {});
}

/**
 * The person's own work (instructions, making, research, folders, call notes) is
 * announced with a notification when it finishes, done or failed, however long it
 * took; so is a connector card waiting for their answer. Main shows it only when
 * the person is not looking at that mulch. Capture and enrichment never notify.
 * The Dock badge counts finished results not yet seen, and main asks before
 * quitting while work is running.
 */
onJobChanged((mulchId, job) => {
  for (const approval of job.approvals ?? []) {
    const key = `approval:${approval.id}`;
    if (announced.has(key)) continue;
    announced.add(key);
    notify(mulchId, { title: `${approval.server.replace(/^claude\.ai\s+/i, "")}: ${approval.tool.replace(/_/g, " ")}` });
  }
  if (job.state === "running") ranHere.add(job.id);
  const finished = job.state === "done" || job.state === "failed";
  if (finished && job.retry && ranHere.has(job.id) && !announced.has(job.id)) {
    ranHere.delete(job.id);
    announced.add(job.id);
    const message = job.message && !job.message.dismissed ? shorten(job.message.text.replace(/\s+/g, " "), 160) : undefined;
    notify(mulchId, {
      ids: job.resultIds,
      title: job.label,
      body: job.state === "failed" ? (job.error ?? "") : message,
      failed: job.state === "failed",
    });
  }
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    void listMulches()
      .then((all) => {
        const total = all.reduce(
          (sum, m) => ({ working: sum.working + (m.activity?.working ?? 0), unseen: sum.unseen + (m.activity?.unseen ?? 0), waiting: sum.waiting + (m.activity?.waiting ?? 0) }),
          { working: 0, unseen: 0, waiting: 0 },
        );
        return desktopRequest("activity", total);
      })
      .catch(() => {});
  }, 500);
});

onFinished((record) => {
  if (record.review && record.status !== "cancelled") submitReview(record.mulchId, record);
});

/** What the person had selected when they gave an instruction: what it is about, and where its results go. */
function selectedBlock(mulch: Mulch, about: string[] | undefined): string {
  const ids = (about ?? []).filter((id) => mulch.nodes[id]);
  if (!ids.length) return "";
  const picked = { ...mulch, nodes: Object.fromEntries(ids.map((id) => [id, mulch.nodes[id]])), edges: {}, groups: {} };
  const lines = describeMulch(picked, { textLimit: 1500 }).split("\n").filter((line) => ids.some((id) => line.startsWith(`${id} [`)));
  return `<selected>\nThe person had these items selected when they gave the instruction. It is about them unless it says otherwise; put what you add near them.\n${lines.join("\n")}\n</selected>\n\n`;
}

export function submitCommand(mulchId: string, instruction: string, options: { inputIds?: string[]; about?: string[]; comment?: string; again?: JobStatus } = {}): JobStatus {
  const { inputIds, about, comment, again } = options;
  return enqueue(mulchId, {
    lane: "command",
    label: shorten(instruction, 60),
    inputIds,
    retry: { kind: "command", input: instruction, ...(about?.length ? { near: about } : {}), ...(comment ? { comment } : {}) },
    async run(job, signal) {
      const mulch = await getMulch(mulchId); // a missing mulch fails the job here
      const jobs = await getJobs(mulchId);
      // The person's turn: their comments, notes, edits and removals since their last instruction.
      // A comment acted on now goes by itself; ones other jobs are acting on now stay with them.
      const busy = new Set(jobs.filter((other) => other.retry?.comment && other.id !== job.id && ["queued", "running", "paused"].includes(other.state)).map((other) => other.retry!.comment!));
      const turn = comment ? commentNow(mulch, comment) : await yourTurn(mulch, lastTurnAt(jobs, job.id), busy);
      if (turn.commentIds.length) {
        const now = Date.now();
        await applyToMulch(mulchId, turn.commentIds.filter((id) => !mulch.comments?.[id]?.sentAt).map((id) => ({ op: "updateComment", id, patch: { sentAt: now, jobId: job.id } })), `agent:${job.id}`);
      }
      await runTurn({
        mulchId,
        job,
        signal,
        lane: "command",
        systemPrompt: commandPrompt,
        prompt:
          (await contextBlock(mulchId)) +
          `<mulch>\n${await mulchContext(mulchId, instruction, 400)}\n</mulch>\n\n${conversationBlock(await callTranscript(mulchId))}` +
          earlierExchanges(jobs, job.id) +
          `Readable files: ${os.homedir()} (read-only; credentials and app data excluded)\n\n${turn.block}${selectedBlock(mulch, about)}<instruction>\n${instruction}\n</instruction>${await relatedElsewhere(mulchId, instruction, { sources: "all" })}`,
        // An instruction can be the first thing on a canvas: it names it then.
        tools: withKeyTools([...COMMAND_TOOLS, ...(mulch.title === "Untitled" ? (["set_title"] as const) : [])]),
        // The person asked: every linked folder, including ones kept for when they ask.
        sources: "all",
        brief: instruction,
        onResearch: (brief, options) => submitResearch(mulchId, brief, options),
        onMake: (brief, options) => submitMake(mulchId, brief, options),
        webAccess: true,
        allowUserEdits: true,
        // Instructions may read the person's files ("look at my dev/briefbuster folder"), read-only.
        readRoot: os.homedir(),
        ownSetup: true,
        // During a call, what it adds goes into the current topic (unless it is about selected cards).
        ...(about?.length ? {} : { call: callTools(mulchId) }),
      });
    },
  }, again);
}

/** Digest a document or link already on the canvas into items around it. */
export function submitIngest(mulchId: string, sourceId: string, label: string, content: string, options: { video?: boolean } = {}): void {
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
        // A video whose pictures weren't read (no Gemini) is looked at here.
        tools: ["add_nodes", "connect", "search_mulch", "read_source", ...(options.video ? (["media_view"] as const) : [])],
      });
      if (added.length) requestEnrichment(mulchId, added.slice(0, 3));
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
export function submitMake(mulchId: string, brief: string, options: LongOptions = {}, again?: JobStatus): JobStatus {
  return enqueue(mulchId, {
    lane: "long",
    label: options.title || shorten(brief, 50),
    retry: { kind: "make", input: brief, ...options },
    near: options.near,
    async run(job, signal) {
      // A continued job also adopts what it saved in earlier periods.
      const started = again ? (job.queuedAt ?? Date.now()) : Date.now();
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
        tools: ["get_mulch", "view_image", "present_file", "preview_artifact", "say", "tell", "search_all_mulches", "read_source", "cold_read"],
        workspace,
        webAccess: true,
        ownSetup: true,
      });
      // Codex makes files without our tools, and Claude may forget one: put any new file on the canvas.
      const current = await getMulch(mulchId);
      const onMulch = new Set(Object.values(current.nodes).map((node) => node.docPath));
      const fresh = (await newArtifacts(mulchId, started)).filter((docPath) => !onMulch.has(docPath));
      for (const docPath of fresh) await addArtifactNode(mulchId, job.id, docPath, job);
    },
  }, again);
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

/** Quiet stops enrichment at once; Live lets what was held run. */
export function setEnrichmentPaused(mulchId: string, paused: boolean): void {
  const entry = jobsFor(mulchId);
  entry.paused = paused;
  if (paused) for (const running of entry.running.slow) running.controller.abort();
  else {
    pump(mulchId, "slow");
    pump(mulchId, "ingest");
  }
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
  if (running) return true;
  // A paused job waits for "keep going"; stopping it ends it.
  void getJobs(mulchId).then((jobs) => {
    const paused = jobs.find((job) => job.id === jobId && job.state === "paused");
    if (paused) void setJob(mulchId, { ...paused, state: "cancelled", finishedAt: Date.now() });
  });
  return false;
}

/** "keep going": a paused job runs another period, resuming its session where it can. */
export async function continueJob(mulchId: string, jobId: string): Promise<JobStatus | undefined> {
  const old = (await getJobs(mulchId)).find((job) => job.id === jobId);
  if (!old?.retry || old.state !== "paused") return undefined;
  const job: JobStatus = { ...old, state: "queued", error: undefined, activity: undefined, finishedAt: undefined, unseen: false };
  resuming.set(job.id, old.session ?? null);
  void setJob(mulchId, { ...job }).catch(() => {});
  const { kind, input, near, title } = old.retry;
  if (kind === "make") return submitMake(mulchId, input, { near, title }, job);
  if (kind === "research") return submitResearch(mulchId, input, { near, title }, job);
  if (kind === "callNotes") return submitCallNotes(mulchId, JSON.parse(input) as { startedAt: number; endedAt: number; transcriptId?: string }, job);
  if (kind === "callTidy") return submitCallTidy(mulchId, JSON.parse(input) as CallFacts, job);
  if (kind === "command") return submitCommand(mulchId, input, { inputIds: old.inputIds, about: near, comment: old.retry.comment, again: job });
  resuming.delete(job.id);
  return undefined;
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
  if (kind === "callNotes") return submitCallNotes(mulchId, JSON.parse(input) as { startedAt: number; endedAt: number; transcriptId?: string });
  if (kind === "callTidy") return submitCallTidy(mulchId, JSON.parse(input) as CallFacts);
  return submitCommand(mulchId, input, { about: near, comment: old.retry.comment });
}
