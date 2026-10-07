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

import { log } from "@/lib/log";
import { getHarness } from "@/lib/agent/server/harnesses";
import type { AgentHarnessStatus, AgentWorkspace, HarnessEvent } from "@/lib/agent/types";
import type { JobLane, JobStatus, TranscriptSegment } from "@/lib/napkin/events";
import { newClientId } from "@/lib/napkin/ids";
import { checkpoint } from "@/lib/napkin/history";
import { applyToNapkin, emit, getNapkin, napkinDir, setJob } from "@/lib/napkin/store";
import { modelFor, readSettings, type Lane } from "@/lib/settings";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adoptArtifact } from "@/lib/artifacts/artifacts";
import { privateDirs } from "./files";
import { placeNear } from "@/lib/napkin/place";
import { artifactHeight, NODE_WIDTH } from "@/lib/napkin/sizes";
import { commandPrompt, fastPrompt, folderPrompt, imagePrompt, ingestPrompt, makerPrompt, researchPrompt, slowPrompt } from "./prompts";
import { onFinished, type GenerationRecord } from "@/lib/media/generations";
import { recordUsage } from "./usage";
import { search } from "@/lib/search";
import { exaAvailable } from "@/lib/search/exa";
import { createNapkinTools, describeNapkin, MAX_REVIEW_ROUNDS, type ToolName } from "./tools";

/** Sources longer than this are read in part; the rest is found by search. */
const LONG_SOURCE = 60_000;

const TIMEOUT_MS: Record<JobLane, number> = { fast: 120_000, slow: 300_000, command: 900_000, ingest: 600_000 };
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
  onMake?: (brief: string) => void;
  onResearch?: (brief: string) => void;
  workspace?: AgentWorkspace;
  /** The person's request (kept for review turns). */
  brief?: string;
  /** Resume this vendor session. */
  sessionId?: string;
  reviewRound?: number;
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

/** Runs one turn; returns the ids of nodes it added and the vendor session. */
async function runTurnWithSession(spec: TurnSpec): Promise<{ added: string[]; sessionId?: string }> {
  await harnessReady();
  const settings = await readSettings();
  const ctx = {
    napkinId: spec.napkinId,
    jobId: spec.job.id,
    tools: spec.tools,
    allowUserEdits: spec.allowUserEdits,
    readRoot: spec.readRoot,
    onHandOff: spec.onHandOff,
    onMake: spec.onMake,
    onResearch: spec.onResearch,
    origin: spec.origin,
    brief: spec.brief,
    reviewRound: spec.reviewRound,
    session: { id: spec.sessionId } as { id?: string },
    added: [] as string[],
  };
  const harness = getHarness(settings.harness);
  const events: AsyncIterable<HarnessEvent> = harness.runTurn({
    ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
    history: [],
    prompt: spec.prompt,
    systemPrompt: spec.systemPrompt,
    tools: createNapkinTools(ctx),
    model: modelFor(settings, spec.lane),
    webAccess: spec.webAccess,
    workspace: spec.workspace,
    signal: spec.signal,
  });
  for await (const event of events) {
    if (event.type === "session") ctx.session.id = event.sessionId;
    if (event.type === "usage") {
      void recordUsage(settings.harness, spec.lane, event.inputTokens ?? 0, event.outputTokens ?? 0);
      log.info("agent", "turn usage", { napkinId: spec.napkinId, jobId: spec.job.id, harness: settings.harness, lane: spec.lane, model: modelFor(settings, spec.lane), inputTokens: event.inputTokens, outputTokens: event.outputTokens });
    }
    if (event.type === "error") {
      log.warn("agent", "turn error", { napkinId: spec.napkinId, jobId: spec.job.id, harness: settings.harness, code: event.code, message: event.message });
      // A refused or failed turn invalidates the cached status.
      state().status = undefined;
      throw new JobError(event.message);
    }
  }
  return { added: ctx.added, sessionId: ctx.session.id };
}

async function runTurn(spec: TurnSpec): Promise<string[]> {
  return (await runTurnWithSession(spec)).added;
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
      log.info("jobs", "job started", { napkinId, jobId: job.id, lane, label: work.label });
      await work.run(job, controller.signal);
      log.info("jobs", controller.signal.aborted ? "job cancelled" : "job finished", { napkinId, jobId: job.id, lane, ms: Date.now() - (job.startedAt ?? Date.now()) });
      await update(napkinId, job, { state: controller.signal.aborted ? "cancelled" : "done", finishedAt: Date.now() });
    } catch (error) {
      const cancelled = controller.signal.aborted && !(controller.signal.reason instanceof Error && controller.signal.reason.message === "Timed out");
      const message = error instanceof Error ? error.message : String(error);
      await update(napkinId, job, { state: cancelled ? "cancelled" : "failed", error: cancelled ? undefined : message, finishedAt: Date.now() }).catch(() => {});
      if (!cancelled) await emit(napkinId, { type: "notice", level: "error", message }).catch(() => {});
      if (!cancelled) log.error("jobs", "job failed", { napkinId, jobId: job.id, lane, label: work.label, ms: Date.now() - (job.startedAt ?? Date.now()), error });
    } finally {
      clearTimeout(timer);
      await checkpoint(napkinId, "job", work.label).catch((error) => log.error("history", "checkpoint failed", { napkinId, error }));
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
        prompt: `<napkin>\n${await napkinContext(napkinId, text, 140)}\n</napkin>\n\n<new_input source="${segments[0]?.source ?? "speech"}">\n${text}\n</new_input>`,
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
      const about = items.map((n) => `${n.title ?? ""} ${n.text}`).join(" ").slice(0, 1000);
      await runTurn({
        napkinId,
        job,
        signal,
        lane: "slow",
        systemPrompt: slowPrompt(settings.enrich, web),
        prompt: `<napkin>\n${await napkinContext(napkinId, about, 160)}\n</napkin>\n\n<new_items>\n${items.map((n) => `${n.id}: ${n.title ? `${n.title} — ` : ""}${n.text}`).join("\n")}\n</new_items>`,
        tools: [
          "add_nodes", "connect", "say",
          ...(settings.enrich.includes("napkins") ? (["search_all_napkins", "bring_in"] as ToolName[]) : []),
          ...(web && exaAvailable() ? (["exa_search"] as ToolName[]) : []),
        ],
        webAccess: web,
      });
    },
  });
  pump(napkinId, "slow");
}

const COMMAND_TOOLS: ToolName[] = [
  "get_napkin", "add_nodes", "connect", "update_node", "remove_nodes", "arrange", "write_doc", "say",
  "write_artifact", "preview_artifact", "make_pptx", "make", "view_image", "caption_image", "list_files", "find_files", "read_file",
  "media_search", "media_schema", "media_generate", "media_wait", "media_view",
  "search_napkin", "search_all_napkins", "read_source", "focus", "bring_in", "research", "read_page",
];

const RESEARCH_TOOLS: ToolName[] = [
  "read_page", "add_nodes", "connect", "arrange", "write_artifact", "preview_artifact", "write_doc", "say", "get_napkin", "search_napkin",
];

/**
 * A research job: many searches and reading, then sources, a comparison table
 * and a write-up on the napkin. If the turn ends without the table or the
 * write-up, the same session is resumed once with what is missing.
 */
export function submitResearch(napkinId: string, brief: string): void {
  enqueue(napkinId, {
    lane: "command",
    label: `Researching: ${brief.length > 46 ? `${brief.slice(0, 43)}…` : brief}`,
    async run(job, signal) {
      const exa = exaAvailable();
      const spec: TurnSpec = {
        napkinId,
        job,
        signal,
        lane: "command",
        systemPrompt: researchPrompt(exa),
        prompt: `<napkin>\n${await napkinContext(napkinId, brief, 300)}\n</napkin>\n\n<brief>\n${brief}\n</brief>`,
        tools: exa ? [...RESEARCH_TOOLS, "exa_search"] : RESEARCH_TOOLS,
        webAccess: true,
        brief,
      };
      const first = await runTurnWithSession(spec);
      const made = async () => {
        const napkin = await getNapkin(napkinId);
        const mine = Object.values(napkin.nodes).filter((n) => n.origin === `agent:${job.id}`);
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
      log.info("jobs", "research incomplete, continuing", { napkinId, jobId: job.id, missing });
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
 * The napkin as the agent sees it in a prompt: everything when it is small;
 * when it is big, the newest items plus the ones that match what this turn
 * is about (the agent can search for more).
 */
async function napkinContext(napkinId: string, about: string, textLimit: number): Promise<string> {
  const napkin = await getNapkin(napkinId);
  const count = Object.keys(napkin.nodes).length;
  if (count <= 150) return describeNapkin(napkin, { textLimit });
  const recent = describeNapkin(napkin, { textLimit, maxNodes: 80 });
  const hits = about.trim() ? await search(about, { napkinIds: [napkinId], limit: 25 }).catch(() => []) : [];
  const relevant = hits.length
    ? `\n\nOlder items related to this turn (from search; use search_napkin for more):\n${hits.map((h) => `${h.nodeId} [${h.kind}]${h.title ? ` "${h.title}"` : ""}${h.page ? ` p.${h.page}` : ""}: ${h.snippet}`).join("\n")}`
    : "";
  return recent + relevant;
}

/** A long generation finished that its turn asked to review: resume that session to check it. */
function submitReview(napkinId: string, record: GenerationRecord): void {
  const review = record.review!;
  enqueue(napkinId, {
    lane: "command",
    label: `Checking ${record.title}`,
    async run(job, signal) {
      const napkin = await getNapkin(napkinId);
      const outcome =
        record.status === "done"
          ? `finished: item ${record.nodeId}${record.extraNodeIds.length ? ` (more outputs: ${record.extraNodeIds.join(", ")})` : ""}. Look at it with media_view.`
          : `${record.status}${record.error ? `: ${record.error}` : ""}.`;
      await runTurn({
        napkinId,
        job,
        signal,
        lane: "command",
        systemPrompt: commandPrompt(),
        prompt:
          `<napkin>\n${describeNapkin(napkin, { textLimit: 300 })}\n</napkin>\n\n` +
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
        onMake: (brief) => submitMake(napkinId, brief),
        onResearch: (brief) => submitResearch(napkinId, brief),
      });
    },
  });
}

onFinished((record) => {
  if (record.review && record.status !== "cancelled") submitReview(record.napkinId, record);
});

export function submitCommand(napkinId: string, instruction: string): void {
  enqueue(napkinId, {
    lane: "command",
    label: instruction.length > 60 ? `${instruction.slice(0, 57)}…` : instruction,
    async run(job, signal) {
      await getNapkin(napkinId); // a missing napkin fails the job here
      await runTurn({
        napkinId,
        job,
        signal,
        lane: "command",
        systemPrompt: commandPrompt(),
        prompt: `<napkin>\n${await napkinContext(napkinId, instruction, 400)}\n</napkin>\n\nReadable files: ${os.homedir()} (read-only; credentials and app data excluded)\n\n<instruction>\n${instruction}\n</instruction>`,
        tools: withKeyTools(COMMAND_TOOLS),
        brief: instruction,
        onResearch: (brief) => submitResearch(napkinId, brief),
        onMake: (brief) => submitMake(napkinId, brief),
        webAccess: true,
        allowUserEdits: true,
        // Instructions may read the person's files ("look at my dev/briefbuster folder"), read-only.
        readRoot: os.homedir(),
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
      await getNapkin(napkinId); // a missing napkin fails the job here
      const added = await runTurn({
        napkinId,
        job,
        signal,
        lane: "slow",
        systemPrompt: ingestPrompt(),
        prompt:
          `<napkin>\n${await napkinContext(napkinId, content.slice(0, 1000), 140)}\n</napkin>\n\n` +
          (content.length > LONG_SOURCE
            ? `This source is long (${Math.round(content.length / 1000)}k characters; the opening is below). Add at most 8 items: what it is, its main argument or structure, and the parts most relevant to this napkin. Its full text is searchable with search_napkin and read_source, so do not summarise it all.\n\n`
            : "") +
          `<source id="${sourceId}">\n${content.slice(0, LONG_SOURCE)}\n</source>`,
        tools: ["add_nodes", "connect", "search_napkin", "read_source"],
      });
      if (added.length) requestEnrichment(napkinId, added.slice(0, 6));
    },
  });
}

/** Hosts a making job's commands may reach: package registries and font/CDN hosts. */
const MAKER_HOSTS = [
  "pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "github.com", "objects.githubusercontent.com",
  "release-assets.githubusercontent.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com",
];

function makerWorkspace(napkinId: string): AgentWorkspace {
  const dir = napkinDir(napkinId);
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

/** Files in artifacts/ changed since `since`, as napkin-relative paths (renamed safe). */
async function newArtifacts(napkinId: string, since: number): Promise<string[]> {
  const dir = path.join(napkinDir(napkinId), "artifacts");
  const found: string[] = [];
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const stat = await fs.stat(path.join(dir, name)).catch(() => undefined);
    if (!stat?.isFile() || stat.mtimeMs < since - 1000) continue;
    const adopted = await adoptArtifact(napkinId, name);
    if (adopted) found.push(adopted);
  }
  return found;
}

/**
 * Make files with the CLI's own tools in its OS sandbox (python-pptx decks,
 * documents, charts). Whatever it saves in artifacts/ lands on the napkin.
 */
export function submitMake(napkinId: string, brief: string): void {
  enqueue(napkinId, {
    lane: "command",
    label: `Making: ${brief.length > 50 ? `${brief.slice(0, 47)}…` : brief}`,
    async run(job, signal) {
      const started = Date.now();
      const workspace = makerWorkspace(napkinId);
      await fs.mkdir(workspace.cwd, { recursive: true });
      await fs.mkdir(workspace.writable[0], { recursive: true });
      const napkin = await getNapkin(napkinId);
      const settings = await readSettings();
      await runTurn({
        napkinId,
        job,
        signal,
        lane: "command",
        systemPrompt: makerPrompt(settings.harness),
        prompt:
          `<napkin>\n${describeNapkin(napkin, { textLimit: 2000 })}\n</napkin>\n\n` +
          `Working folder (scratch): ${workspace.cwd}\nSave finished files in: ${workspace.writable[0]}\n` +
          `Napkin files (images, documents) are in: ${path.join(napkinDir(napkinId), "assets")}\n\n<brief>\n${brief}\n</brief>`,
        tools: ["get_napkin", "view_image", "present_file", "preview_artifact", "say"],
        workspace,
        webAccess: true,
      });
      // Codex makes files without our tools, and Claude may forget one: put any new file on the napkin.
      const current = await getNapkin(napkinId);
      const onNapkin = new Set(Object.values(current.nodes).map((node) => node.docPath));
      const fresh = (await newArtifacts(napkinId, started)).filter((docPath) => !onNapkin.has(docPath));
      for (const docPath of fresh) await addArtifactNode(napkinId, job.id, docPath);
    },
  });
}

async function addArtifactNode(napkinId: string, jobId: string, docPath: string): Promise<void> {
  const napkin = await getNapkin(napkinId);
  const id = newClientId("n");
  const name = path.basename(docPath);
  const position = placeNear(napkin, { w: NODE_WIDTH.artifact, h: artifactHeight(docPath) }, { seed: id });
  await applyToNapkin(
    napkinId,
    [{ op: "addNode", node: { id, kind: "artifact", x: position.x, y: position.y, title: name.replace(/\.[a-z0-9]+$/, "").replace(/[-_]+/g, " "), text: "", docPath, fileName: name, origin: `agent:${jobId}`, createdAt: Date.now() } }],
    `agent:${jobId}`,
  );
}

/** Look at a dropped image: caption it and add what it brings to the napkin. */
export function submitImage(napkinId: string, nodeId: string, label: string): void {
  enqueue(napkinId, {
    lane: "ingest",
    label,
    async run(job, signal) {
      const napkin = await getNapkin(napkinId);
      await runTurn({
        napkinId,
        job,
        signal,
        lane: "slow",
        systemPrompt: imagePrompt(),
        prompt: `<napkin>\n${describeNapkin(napkin, { textLimit: 140, maxNodes: 120 })}\n</napkin>\n\nNew image: ${nodeId}`,
        tools: ["view_image", "caption_image", "add_nodes", "connect"],
      });
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
        tools: ["list_files", "find_files", "read_file", "add_nodes", "connect", "arrange", "say", "set_title"],
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
