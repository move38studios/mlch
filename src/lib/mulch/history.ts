/**
 * Mulch history: checkpoints you can travel back to. Server-only.
 *
 * After design in briefbuster's TIMETRAVEL.md: self-contained snapshots,
 * deduplicated by content hash, kept forever. The op log (events.jsonl) is
 * the finer record; checkpoints are what the timeline shows.
 *
 *   history/index.jsonl        one line per checkpoint
 *   history/<at>.json.gz       the mulch at that moment
 *
 * A checkpoint is written after each agent job, and while the person edits,
 * at most once a minute (a few seconds after edits settle). Restoring writes
 * a `pre-restore` checkpoint first, then applies the difference as ordinary
 * ops, so a restore can itself be undone or travelled back from.
 */

import { log } from "@/lib/log";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { Mulch, MulchOp } from "./types";
import { applyToMulch, atomicWriteFile, getMulch, mulchDir, onAfterApply } from "./store";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export type CheckpointKind = "edit" | "job" | "pre-restore" | "restore";

export interface Checkpoint {
  at: number;
  kind: CheckpointKind;
  hash: string;
  nodeCount: number;
  /** What happened just before ("Capturing", "Restored 08:12"). */
  label?: string;
}

const MIN_INTERVAL_MS = 60_000;
const SETTLE_MS = 5_000;

interface HistoryState {
  lastHash: Map<string, string>;
  lastAt: Map<string, number>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  /** Writes per mulch, in order. */
  chains: Map<string, Promise<unknown>>;
}

const globalState = globalThis as typeof globalThis & { __mulchHistory?: HistoryState };
function state(): HistoryState {
  return (globalState.__mulchHistory ??= { lastHash: new Map(), lastAt: new Map(), timers: new Map(), chains: new Map() });
}

function historyDir(id: string): string {
  return path.join(mulchDir(id), "history");
}

/** Hash of what the mulch shows; updatedAt and measured sizes do not count. */
export function contentHash(mulch: Mulch): string {
  const nodes = Object.values(mulch.nodes)
    .map(({ h: _h, updatedAt: _u, ...rest }) => rest)
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = Object.values(mulch.edges).sort((a, b) => a.id.localeCompare(b.id));
  const groups = Object.values(mulch.groups).sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify({ title: mulch.title, nodes, edges, groups })).digest("hex").slice(0, 32);
}

export async function listCheckpoints(id: string): Promise<Checkpoint[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(historyDir(id), "index.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Checkpoint];
      } catch {
        return [];
      }
    });
}

function serial<T>(id: string, work: () => Promise<T>): Promise<T> {
  const chains = state().chains;
  const next = (chains.get(id) ?? Promise.resolve()).then(work, work);
  chains.set(id, next.catch(() => {}));
  return next;
}

/** Write a checkpoint now unless nothing changed since the last one. */
export function checkpoint(id: string, kind: CheckpointKind, label?: string): Promise<Checkpoint | undefined> {
  return serial(id, async () => {
    const mulch = await getMulch(id);
    const hash = contentHash(mulch);
    const s = state();
    if (!s.lastHash.has(id)) {
      const last = (await listCheckpoints(id)).at(-1);
      if (last) s.lastHash.set(id, last.hash);
    }
    if (s.lastHash.get(id) === hash && kind !== "pre-restore") return undefined;
    // Two checkpoints in the same millisecond would share a file name.
    const at = Math.max(Date.now(), (s.lastAt.get(id) ?? 0) + 1);
    const entry: Checkpoint = { at, kind, hash, nodeCount: Object.keys(mulch.nodes).length, ...(label ? { label } : {}) };
    await atomicWriteFile(path.join(historyDir(id), `${at}.json.gz`), await gzipAsync(JSON.stringify(mulch)));
    await fs.appendFile(path.join(historyDir(id), "index.jsonl"), JSON.stringify(entry) + "\n");
    s.lastHash.set(id, hash);
    s.lastAt.set(id, at);
    return entry;
  });
}

export async function readCheckpoint(id: string, at: number): Promise<Mulch> {
  if (!Number.isSafeInteger(at)) throw new Error("Invalid checkpoint.");
  return JSON.parse((await gunzipAsync(await fs.readFile(path.join(historyDir(id), `${at}.json.gz`)))).toString("utf8")) as Mulch;
}

/** The ops that turn `current` into `target`. */
export function diffOps(current: Mulch, target: Mulch): MulchOp[] {
  const ops: MulchOp[] = [];
  for (const edge of Object.values(current.edges)) if (!target.edges[edge.id]) ops.push({ op: "removeEdge", id: edge.id });
  for (const group of Object.values(current.groups)) if (!target.groups[group.id]) ops.push({ op: "removeGroup", id: group.id });
  for (const node of Object.values(current.nodes)) if (!target.nodes[node.id]) ops.push({ op: "removeNode", id: node.id });
  for (const group of Object.values(target.groups)) {
    const now = current.groups[group.id];
    if (!now) ops.push({ op: "addGroup", group });
    else if (JSON.stringify(now) !== JSON.stringify(group)) ops.push({ op: "updateGroup", id: group.id, patch: clearing(now, group) });
  }
  for (const node of Object.values(target.nodes)) {
    const now = current.nodes[node.id];
    if (!now) ops.push({ op: "addNode", node });
    else if (JSON.stringify(now) !== JSON.stringify(node)) ops.push({ op: "updateNode", id: node.id, patch: clearing(now, node) });
  }
  for (const edge of Object.values(target.edges)) {
    const now = current.edges[edge.id];
    if (!now) ops.push({ op: "addEdge", edge });
    else if (now.label !== edge.label) ops.push({ op: "updateEdge", id: edge.id, patch: { label: edge.label ?? null } });
  }
  if (current.title !== target.title) ops.push({ op: "setTitle", title: target.title });
  return ops;
}

/** A patch that makes `from` equal `to`: changed fields set, missing fields cleared. */
function clearing<T extends object>(from: T, to: T): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const a = from as Record<string, unknown>;
  const b = to as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === "id" || key === "createdAt") continue;
    if (!(key in b)) patch[key] = null;
    else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) patch[key] = b[key];
  }
  return patch;
}

export async function restoreCheckpoint(id: string, at: number): Promise<void> {
  const target = await readCheckpoint(id, at);
  await checkpoint(id, "pre-restore");
  const ops = diffOps(await getMulch(id), target);
  if (ops.length) await applyToMulch(id, ops, "restore");
  await checkpoint(id, "restore", `Restored ${new Date(at).toISOString()}`);
}

/** Edits settle into a checkpoint at most once a minute. */
function scheduleEditCheckpoint(id: string): void {
  const s = state();
  if (s.timers.has(id)) return;
  const since = Date.now() - (s.lastAt.get(id) ?? 0);
  const delay = Math.max(SETTLE_MS, MIN_INTERVAL_MS - since);
  s.timers.set(
    id,
    setTimeout(() => {
      s.timers.delete(id);
      checkpoint(id, "edit").catch((error) => log.error("history", "checkpoint failed", { mulchId: id, error }));
    }, delay),
  );
}

onAfterApply((id, batch) => {
  // Agent batches are checkpointed when their job ends; restores checkpoint themselves.
  if (batch.origin === "user" || batch.origin === "ingest") scheduleEditCheckpoint(id);
});
