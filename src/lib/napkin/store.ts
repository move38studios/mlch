/**
 * Napkins on disk. Server-only.
 *
 * Each napkin is a folder in the library (desktop/server.ts libraryDir):
 *
 *   napkin.json           current board
 *   events.jsonl          every op batch, appended
 *   transcript.jsonl      speech and typed input segments
 *   history/<ts>.json.gz  checkpoints (history.ts)
 *   assets/               dropped files, content-addressed
 *   docs/                 write-ups
 *
 * Open napkins are held in memory (on globalThis, so a dev reload keeps
 * them) and are the single source of truth while open: the browser and the
 * agent both send ops here, which are applied, logged and broadcast.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { libraryDir } from "@/lib/desktop/server";
import { newClientId } from "./ids";
import { applyOps, emptyNapkin } from "./ops";
import type { JobStatus, ServerEvent, TranscriptSegment } from "./events";
import type { Napkin, NapkinOp, NapkinSummary, OpBatch, Origin } from "./types";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SAVE_DELAY_MS = 400;

type Listener = (event: ServerEvent) => void;

interface OpenNapkin {
  napkin: Napkin;
  transcript: TranscriptSegment[];
  jobs: Map<string, JobStatus>;
  paused: boolean;
  listeners: Set<Listener>;
  saveTimer?: ReturnType<typeof setTimeout>;
}

interface StoreState {
  open: Map<string, OpenNapkin>;
  loading: Map<string, Promise<OpenNapkin>>;
  /** Called after every applied batch (history.ts hooks checkpoints here). */
  afterApply: Array<(id: string, batch: OpBatch) => void>;
}

const globalState = globalThis as typeof globalThis & { __npknStore?: StoreState };
function state(): StoreState {
  if (!globalState.__npknStore) {
    globalState.__npknStore = { open: new Map(), loading: new Map(), afterApply: [] };
    const flush = () => void flushAll();
    process.once("SIGTERM", flush);
    process.once("beforeExit", flush);
  }
  return globalState.__npknStore;
}

export class NapkinNotFoundError extends Error {
  constructor(id: string) {
    super(`Napkin ${id} not found.`);
  }
}

export function isNapkinId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function napkinDir(id: string): string {
  if (!isNapkinId(id)) throw new NapkinNotFoundError(id);
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

export async function listNapkins(): Promise<NapkinSummary[]> {
  const root = libraryDir();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const summaries = await Promise.all(
    entries.filter(isNapkinId).map(async (id): Promise<NapkinSummary | undefined> => {
      const open = state().open.get(id);
      try {
        const napkin = open?.napkin ?? (JSON.parse(await fs.readFile(path.join(root, id, "napkin.json"), "utf8")) as Napkin);
        return {
          id,
          title: napkin.title,
          createdAt: napkin.createdAt,
          updatedAt: napkin.updatedAt,
          nodeCount: Object.keys(napkin.nodes).length,
        };
      } catch {
        return undefined;
      }
    }),
  );
  return summaries.filter((s): s is NapkinSummary => !!s).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createNapkin(title = "Untitled"): Promise<Napkin> {
  const id = newId();
  const napkin = emptyNapkin(id, title, Date.now());
  const dir = napkinDir(id);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(path.join(dir, "napkin.json"), JSON.stringify(napkin, null, 1));
  return napkin;
}

/** Moves the folder to the library's .trash rather than deleting it. */
export async function trashNapkin(id: string): Promise<void> {
  const dir = napkinDir(id);
  const open = state().open.get(id);
  if (open?.saveTimer) clearTimeout(open.saveTimer);
  state().open.delete(id);
  if (!existsSync(dir)) throw new NapkinNotFoundError(id);
  const trash = path.join(libraryDir(), ".trash");
  await fs.mkdir(trash, { recursive: true });
  await fs.rename(dir, path.join(trash, `${id}-${Date.now()}`));
}

/* ── open napkins ──────────────────────────────────────────────── */

export async function openNapkin(id: string): Promise<OpenNapkin> {
  const s = state();
  const existing = s.open.get(id);
  if (existing) return existing;
  const pending = s.loading.get(id);
  if (pending) return pending;
  const load = (async () => {
    const dir = napkinDir(id);
    let napkin: Napkin;
    try {
      napkin = JSON.parse(await fs.readFile(path.join(dir, "napkin.json"), "utf8")) as Napkin;
    } catch {
      throw new NapkinNotFoundError(id);
    }
    const transcript = await readJsonLines<TranscriptSegment>(path.join(dir, "transcript.jsonl"));
    const entry: OpenNapkin = {
      napkin,
      transcript,
      jobs: new Map(),
      paused: false,
      listeners: new Set(),
    };
    s.open.set(id, entry);
    return entry;
  })().finally(() => s.loading.delete(id));
  s.loading.set(id, load);
  return load;
}

export async function getNapkin(id: string): Promise<Napkin> {
  return (await openNapkin(id)).napkin;
}

function broadcast(entry: OpenNapkin, event: ServerEvent): void {
  for (const listener of entry.listeners) {
    try {
      listener(event);
    } catch {
      // A closed stream; its own cleanup removes it.
    }
  }
}

export async function emit(id: string, event: ServerEvent): Promise<void> {
  broadcast(await openNapkin(id), event);
}

async function save(id: string): Promise<void> {
  const entry = state().open.get(id);
  if (!entry) return;
  entry.saveTimer = undefined;
  await atomicWriteFile(path.join(napkinDir(id), "napkin.json"), JSON.stringify(entry.napkin, null, 1));
}

function scheduleSave(id: string, entry: OpenNapkin): void {
  if (entry.saveTimer) clearTimeout(entry.saveTimer);
  entry.saveTimer = setTimeout(() => {
    save(id).catch((error) => console.error(`[napkin] save ${id} failed`, error));
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
 * Apply ops to an open napkin, log and broadcast them. Returns the batch, or
 * undefined when nothing changed.
 */
export async function applyToNapkin(
  id: string,
  ops: NapkinOp[],
  origin: Origin,
  clientId?: string,
): Promise<OpBatch | undefined> {
  const entry = await openNapkin(id);
  const now = Date.now();
  const next = applyOps(entry.napkin, ops, now);
  if (next === entry.napkin) return undefined;
  entry.napkin = next;
  const batch: OpBatch = { id: newClientId("b"), napkinId: id, ops, origin, ...(clientId ? { clientId } : {}), at: now };
  await fs.appendFile(path.join(napkinDir(id), "events.jsonl"), JSON.stringify(batch) + "\n");
  scheduleSave(id, entry);
  await syncDocs(id, next, ops);
  broadcast(entry, { type: "ops", batch });
  for (const hook of state().afterApply) hook(id, batch);
  return batch;
}

/** A write-up edited on the canvas updates its file in docs/. */
async function syncDocs(id: string, napkin: Napkin, ops: NapkinOp[]): Promise<void> {
  for (const op of ops) {
    if (op.op !== "updateNode" || op.patch.text === undefined) continue;
    const docPath = napkin.nodes[op.id]?.docPath;
    if (!docPath || !/^docs\/[a-z0-9-]+\.md$/.test(docPath)) continue;
    await atomicWriteFile(path.join(napkinDir(id), docPath), op.patch.text ?? "");
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
  const entry = await openNapkin(id);
  entry.transcript.push(segment);
  await fs.appendFile(path.join(napkinDir(id), "transcript.jsonl"), JSON.stringify(segment) + "\n");
  broadcast(entry, { type: "transcript", segment });
}

export async function setJob(id: string, job: JobStatus): Promise<void> {
  const entry = await openNapkin(id);
  entry.jobs.set(job.id, job);
  // Keep the list short: finished jobs older than the last 30 drop off.
  const finished = [...entry.jobs.values()].filter((j) => j.state !== "queued" && j.state !== "running");
  for (const old of finished.slice(0, Math.max(0, finished.length - 30))) entry.jobs.delete(old.id);
  broadcast(entry, { type: "job", job });
}

export async function setPaused(id: string, paused: boolean): Promise<void> {
  const entry = await openNapkin(id);
  entry.paused = paused;
  broadcast(entry, { type: "paused", paused });
}

/** Subscribe to a napkin's events. The first event is always a snapshot. */
export async function subscribe(id: string, listener: Listener): Promise<() => void> {
  const entry = await openNapkin(id);
  listener({
    type: "snapshot",
    napkin: entry.napkin,
    transcript: entry.transcript,
    jobs: [...entry.jobs.values()],
    paused: entry.paused,
  });
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}
