/**
 * Mulches on disk. Server-only.
 *
 * Each mulch is a folder in the library (desktop/server.ts libraryDir):
 *
 *   mulch.json           current board
 *   events.jsonl          every op batch, appended
 *   transcript.jsonl      speech and typed input segments
 *   history/<ts>.json.gz  checkpoints (history.ts)
 *   assets/               dropped files, content-addressed
 *   docs/                 write-ups
 *
 * Open mulches are held in memory (on globalThis, so a dev reload keeps
 * them) and are the single source of truth while open: the browser and the
 * agent both send ops here, which are applied, logged and broadcast.
 */

import { log } from "@/lib/log";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { libraryDir } from "@/lib/desktop/server";
import { newClientId } from "./ids";
import { applyOps, emptyMulch } from "./ops";
import { jobActivity, type JobStatus, type ServerEvent, type TranscriptSegment } from "./events";
import type { Mulch, MulchOp, MulchSummary, OpBatch, Origin } from "./types";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SAVE_DELAY_MS = 400;

type Listener = (event: ServerEvent) => void;

interface OpenMulch {
  mulch: Mulch;
  transcript: TranscriptSegment[];
  jobs: Map<string, JobStatus>;
  paused: boolean;
  listeners: Set<Listener>;
  saveTimer?: ReturnType<typeof setTimeout>;
  jobsTimer?: ReturnType<typeof setTimeout>;
}

interface StoreState {
  open: Map<string, OpenMulch>;
  loading: Map<string, Promise<OpenMulch>>;
  /** Called after every applied batch (history.ts hooks checkpoints here). */
  afterApply: Array<(id: string, batch: OpBatch) => void>;
  /** Called when a kept job changes (the Dock badge and notifications hook here). */
  jobChanged: Array<(id: string, job: JobStatus) => void>;
}

const globalState = globalThis as typeof globalThis & { __mlchStore?: StoreState };
function state(): StoreState {
  if (!globalState.__mlchStore) {
    globalState.__mlchStore = { open: new Map(), loading: new Map(), afterApply: [], jobChanged: [] };
    const flush = () => void flushAll();
    process.once("SIGTERM", flush);
    process.once("beforeExit", flush);
  }
  return globalState.__mlchStore;
}

export class MulchNotFoundError extends Error {
  constructor(id: string) {
    super(`Not found: ${id}.`);
  }
}

export function isMulchId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function mulchDir(id: string): string {
  if (!isMulchId(id)) throw new MulchNotFoundError(id);
  return path.join(libraryDir(), id);
}

export async function atomicWriteFile(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, data);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn last line from a crash; skip it.
    }
  }
  return out;
}

function newId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}


/* ── listing ───────────────────────────────────────────────────── */

export async function listMulches(): Promise<MulchSummary[]> {
  const root = libraryDir();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const summaries = await Promise.all(
    entries.filter(isMulchId).map(async (id): Promise<MulchSummary | undefined> => {
      const open = state().open.get(id);
      try {
        const mulch = open?.mulch ?? (JSON.parse(await fs.readFile(path.join(root, id, "mulch.json"), "utf8")) as Mulch);
        const jobs = open ? [...open.jobs.values()] : await readKeptJobs(path.join(root, id));
        return {
          id,
          title: mulch.title,
          createdAt: mulch.createdAt,
          updatedAt: mulch.updatedAt,
          nodeCount: Object.keys(mulch.nodes).length,
          activity: jobActivity(jobs),
        };
      } catch {
        return undefined;
      }
    }),
  );
  return summaries.filter((s): s is MulchSummary => !!s).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createMulch(title = "Untitled"): Promise<Mulch> {
  const id = newId();
  const mulch = emptyMulch(id, title, Date.now());
  const dir = mulchDir(id);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(path.join(dir, "mulch.json"), JSON.stringify(mulch, null, 1));
  return mulch;
}

/** Moves the folder to the library's .trash rather than deleting it. */
export async function trashMulch(id: string): Promise<void> {
  const dir = mulchDir(id);
  const open = state().open.get(id);
  if (open?.saveTimer) clearTimeout(open.saveTimer);
  state().open.delete(id);
  if (!existsSync(dir)) throw new MulchNotFoundError(id);
  const trash = path.join(libraryDir(), ".trash");
  await fs.mkdir(trash, { recursive: true });
  await fs.rename(dir, path.join(trash, `${id}-${Date.now()}`));
}

/* ── open mulches ──────────────────────────────────────────────── */

export async function openMulch(id: string): Promise<OpenMulch> {
  const s = state();
  const existing = s.open.get(id);
  if (existing) return existing;
  const pending = s.loading.get(id);
  if (pending) return pending;
  const load = (async () => {
    const dir = mulchDir(id);
    let mulch: Mulch;
    try {
      mulch = JSON.parse(await fs.readFile(path.join(dir, "mulch.json"), "utf8")) as Mulch;
    } catch {
      throw new MulchNotFoundError(id);
    }
    const transcript = await readJsonLines<TranscriptSegment>(path.join(dir, "transcript.jsonl"));
    const entry: OpenMulch = {
      mulch,
      transcript,
      jobs: new Map((await readKeptJobs(dir)).map((job) => [job.id, job])),
      paused: false,
      listeners: new Set(),
    };
    s.open.set(id, entry);
    return entry;
  })().finally(() => s.loading.delete(id));
  s.loading.set(id, load);
  return load;
}

export async function getMulch(id: string): Promise<Mulch> {
  return (await openMulch(id)).mulch;
}

function broadcast(entry: OpenMulch, event: ServerEvent): void {
  for (const listener of entry.listeners) {
    try {
      listener(event);
    } catch {
      // A closed stream; its own cleanup removes it.
    }
  }
}

export async function emit(id: string, event: ServerEvent): Promise<void> {
  broadcast(await openMulch(id), event);
}

async function save(id: string): Promise<void> {
  const entry = state().open.get(id);
  if (!entry) return;
  entry.saveTimer = undefined;
  await atomicWriteFile(path.join(mulchDir(id), "mulch.json"), JSON.stringify(entry.mulch, null, 1));
}

function scheduleSave(id: string, entry: OpenMulch): void {
  if (entry.saveTimer) clearTimeout(entry.saveTimer);
  entry.saveTimer = setTimeout(() => {
    save(id).catch((error) => log.error("mulch", "save failed", { mulchId: id, error }));
  }, SAVE_DELAY_MS);
}

export async function flushAll(): Promise<void> {
  await Promise.all(
    [...state().open.entries()]
      .filter(([, entry]) => entry.saveTimer)
      .map(([id, entry]) => {
        clearTimeout(entry.saveTimer);
        return save(id);
      }),
  );
}

/**
 * Apply ops to an open mulch, log and broadcast them. Returns the batch, or
 * undefined when nothing changed.
 */
export async function applyToMulch(
  id: string,
  ops: MulchOp[],
  origin: Origin,
  clientId?: string,
): Promise<OpBatch | undefined> {
  const entry = await openMulch(id);
  const now = Date.now();
  const next = applyOps(entry.mulch, ops, now);
  if (next === entry.mulch) return undefined;
  entry.mulch = next;
  const batch: OpBatch = { id: newClientId("b"), mulchId: id, ops, origin, ...(clientId ? { clientId } : {}), at: now };
  await fs.appendFile(path.join(mulchDir(id), "events.jsonl"), JSON.stringify(batch) + "\n");
  scheduleSave(id, entry);
  await syncDocs(id, next, ops);
  broadcast(entry, { type: "ops", batch });
  for (const hook of state().afterApply) hook(id, batch);
  return batch;
}

/** A write-up edited on the canvas updates its file in docs/. */
async function syncDocs(id: string, mulch: Mulch, ops: MulchOp[]): Promise<void> {
  for (const op of ops) {
    if (op.op !== "updateNode" || op.patch.text === undefined) continue;
    const docPath = mulch.nodes[op.id]?.docPath;
    if (!docPath || !/^docs\/[a-z0-9-]+\.md$/.test(docPath)) continue;
    await atomicWriteFile(path.join(mulchDir(id), docPath), op.patch.text ?? "");
  }
}

export function onAfterApply(hook: (id: string, batch: OpBatch) => void): void {
  const hooks = state().afterApply;
  // Dev reloads re-run module code; keep one hook per source.
  const key = hook.toString();
  const index = hooks.findIndex((h) => h.toString() === key);
  if (index >= 0) hooks.splice(index, 1);
  hooks.push(hook);
}

export async function appendTranscript(id: string, segment: TranscriptSegment): Promise<void> {
  const entry = await openMulch(id);
  entry.transcript.push(segment);
  await fs.appendFile(path.join(mulchDir(id), "transcript.jsonl"), JSON.stringify(segment) + "\n");
  broadcast(entry, { type: "transcript", segment });
}

/**
 * The person's instructions and long work (jobs with `retry`) are kept in
 * jobs.json. One that was queued or running when the app last stopped is
 * marked failed, so it can be retried.
 */
async function readKeptJobs(dir: string): Promise<JobStatus[]> {
  let jobs: JobStatus[];
  try {
    jobs = JSON.parse(await fs.readFile(path.join(dir, "jobs.json"), "utf8")) as JobStatus[];
  } catch {
    return [];
  }
  return jobs.map((job) =>
    job.state === "queued" || job.state === "running"
      ? { ...job, state: "failed", error: "Stopped when mlch quit.", activity: undefined, anchor: undefined, unseen: true, finishedAt: job.finishedAt ?? Date.now() }
      : job,
  );
}

function saveKeptJobs(id: string, entry: OpenMulch): void {
  clearTimeout(entry.jobsTimer);
  entry.jobsTimer = setTimeout(() => {
    const kept = [...entry.jobs.values()].filter((job) => job.retry);
    void atomicWriteFile(path.join(mulchDir(id), "jobs.json"), JSON.stringify(kept, null, 1)).catch((error) =>
      log.error("store", "jobs save failed", { mulchId: id, error }),
    );
  }, 400);
}

export async function setJob(id: string, job: JobStatus): Promise<void> {
  const entry = await openMulch(id);
  entry.jobs.set(job.id, job);
  // Keep the list short: the last 30 finished kept jobs, the last 10 others.
  const finished = [...entry.jobs.values()].filter((j) => j.state !== "queued" && j.state !== "running");
  for (const [list, keep] of [[finished.filter((j) => j.retry), 30], [finished.filter((j) => !j.retry), 10]] as const) {
    for (const old of list.slice(0, Math.max(0, list.length - keep))) entry.jobs.delete(old.id);
  }
  broadcast(entry, { type: "job", job });
  if (job.retry) {
    saveKeptJobs(id, entry);
    for (const hook of state().jobChanged) hook(id, job);
  }
}

export async function getJobs(id: string): Promise<JobStatus[]> {
  return [...(await openMulch(id)).jobs.values()];
}

/** The person has seen these finished jobs. */
export async function markJobsSeen(id: string, jobIds: string[]): Promise<void> {
  const entry = await openMulch(id);
  for (const jobId of jobIds) {
    const job = entry.jobs.get(jobId);
    if (job?.unseen) await setJob(id, { ...job, unseen: false });
  }
}

export function onJobChanged(hook: (id: string, job: JobStatus) => void): void {
  const hooks = state().jobChanged;
  const key = hook.toString();
  const index = hooks.findIndex((h) => h.toString() === key);
  if (index >= 0) hooks.splice(index, 1);
  hooks.push(hook);
}

export async function setPaused(id: string, paused: boolean): Promise<void> {
  const entry = await openMulch(id);
  entry.paused = paused;
  broadcast(entry, { type: "paused", paused });
}

/** Subscribe to a mulch's events. The first event is always a snapshot. */
export async function subscribe(id: string, listener: Listener): Promise<() => void> {
  const entry = await openMulch(id);
  listener({
    type: "snapshot",
    mulch: entry.mulch,
    transcript: entry.transcript,
    jobs: [...entry.jobs.values()],
    paused: entry.paused,
  });
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}
