/**
 * Media generations on fal, owned by the server. Server-only.
 *
 * The agent starts a generation and goes on; this module puts a card on the
 * napkin at once, polls fal's queue and keeps the card's status current,
 * saves the outputs into the napkin's assets/ (fal URLs expire), and finishes
 * the card. Records live in <napkin>/generations.json, so polling resumes
 * after a restart. An agent can wait for generations within its turn
 * (`waitFor`), or ask to be called back when one finishes (`onFinished`, used
 * for review turns).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { saveAsset } from "@/lib/ingest/ingest";
import { assetPath } from "@/lib/ingest/ingest";
import { newClientId } from "@/lib/napkin/ids";
import { placeNear } from "@/lib/napkin/place";
import { NODE_WIDTH } from "@/lib/napkin/sizes";
import { applyToNapkin, atomicWriteFile, getNapkin, napkinDir } from "@/lib/napkin/store";
import type { GenerationState, NapkinNode, NapkinOp } from "@/lib/napkin/types";
import * as fal from "./fal";
import { recordSpend } from "./spend";

export interface ReviewRequest {
  /** What the person asked for, for the review turn. */
  brief: string;
  round: number;
  sessionId?: string;
}

export interface GenerationRecord {
  id: string;
  napkinId: string;
  nodeId: string;
  endpoint: string;
  title: string;
  /** Input as submitted (napkin items replaced by upload URLs). */
  input: Record<string, unknown>;
  handle?: fal.QueueHandle;
  status: GenerationState["status"];
  error?: string;
  cost?: number;
  /** Nodes holding outputs beyond the first. */
  extraNodeIds: string[];
  origin: string;
  review?: ReviewRequest;
  createdAt: number;
  finishedAt?: number;
}

const MAX_RUN_MS = 45 * 60_000;
const MAX_DOWNLOAD = 1024 * 1024 * 1024;

interface State {
  records: Map<string, GenerationRecord>;
  polling: Set<string>;
  waiters: Map<string, Array<() => void>>;
  loaded: Set<string>;
  finishedHooks: Array<(record: GenerationRecord) => void>;
}

const globalState = globalThis as typeof globalThis & { __npknGenerations?: State };
function state(): State {
  return (globalState.__npknGenerations ??= { records: new Map(), polling: new Set(), waiters: new Map(), loaded: new Set(), finishedHooks: [] });
}

/** Called when any generation finishes (done, failed or cancelled). One hook per source. */
export function onFinished(hook: (record: GenerationRecord) => void): void {
  const hooks = state().finishedHooks;
  const index = hooks.findIndex((h) => h.toString() === hook.toString());
  if (index >= 0) hooks.splice(index, 1);
  hooks.push(hook);
}

function recordsFile(napkinId: string): string {
  return path.join(napkinDir(napkinId), "generations.json");
}

async function persist(napkinId: string): Promise<void> {
  const records = [...state().records.values()].filter((r) => r.napkinId === napkinId);
  await atomicWriteFile(recordsFile(napkinId), JSON.stringify(records, null, 1));
}

async function load(napkinId: string): Promise<void> {
  const s = state();
  if (s.loaded.has(napkinId)) return;
  s.loaded.add(napkinId);
  try {
    const records = JSON.parse(await fs.readFile(recordsFile(napkinId), "utf8")) as GenerationRecord[];
    for (const record of records) if (!s.records.has(record.id)) s.records.set(record.id, record);
  } catch {
    // none yet
  }
}

export async function getGeneration(napkinId: string, id: string): Promise<GenerationRecord | undefined> {
  await load(napkinId);
  const record = state().records.get(id);
  return record?.napkinId === napkinId ? record : undefined;
}

/** The generation behind a media item. */
export async function generationForNode(napkinId: string, nodeId: string): Promise<GenerationRecord | undefined> {
  await load(napkinId);
  return [...state().records.values()].find((r) => r.napkinId === napkinId && (r.nodeId === nodeId || r.extraNodeIds.includes(nodeId)));
}

/** Resume polling unfinished generations of a napkin (after a restart). */
export async function resumeGenerations(napkinId: string): Promise<void> {
  await load(napkinId);
  for (const record of state().records.values()) {
    if (record.napkinId === napkinId && record.handle && (record.status === "queued" || record.status === "running")) poll(record);
  }
}

function genState(record: GenerationRecord, extra: Partial<GenerationState> = {}): GenerationState {
  return {
    id: record.id,
    endpoint: record.endpoint,
    status: record.status,
    ...(record.error ? { error: record.error.slice(0, 1500) } : {}),
    ...(record.cost !== undefined ? { cost: record.cost } : {}),
    startedAt: record.createdAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...extra,
  };
}

async function updateNode(record: GenerationRecord, patch: Partial<NapkinNode>): Promise<void> {
  await applyToNapkin(record.napkinId, [{ op: "updateNode", id: record.nodeId, patch }], record.origin);
}

/* ── inputs: napkin items as files ─────────────────────────────── */

const NAPKIN_REF = /^napkin:([a-z]+-[a-f0-9]+)$/;

/** Replace "napkin:<item id>" strings in the input with uploaded URLs of those items' files. */
export async function resolveInputs(napkinId: string, value: unknown): Promise<unknown> {
  if (typeof value === "string") {
    const match = value.match(NAPKIN_REF);
    if (!match) return value;
    const node = (await getNapkin(napkinId)).nodes[match[1]];
    if (!node?.assetId) throw new fal.FalError(`${match[1]} has no file to use as input (use image, media or document items).`);
    const bytes = await fs.readFile(assetPath(napkinId, node.assetId));
    const mime = node.mime ?? guessMime(node.assetId);
    return fal.uploadFile(bytes, mime, node.fileName ?? node.assetId);
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveInputs(napkinId, item)));
  if (value && typeof value === "object") {
    const entries = await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await resolveInputs(napkinId, v)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".pdf": "application/pdf",
};
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]));

export function guessMime(name: string): string {
  return MIME_BY_EXT[path.extname(name.split("?")[0]).toLowerCase()] ?? "application/octet-stream";
}

/* ── starting ──────────────────────────────────────────────────── */

export interface StartOptions {
  napkinId: string;
  endpoint: string;
  input: Record<string, unknown>;
  title: string;
  prompt: string;
  near?: string[];
  origin: string;
  cost?: number;
  review?: ReviewRequest;
}

export async function startGeneration(options: StartOptions): Promise<GenerationRecord> {
  await load(options.napkinId);
  const napkin = await getNapkin(options.napkinId);
  const record: GenerationRecord = {
    id: newClientId("g"),
    napkinId: options.napkinId,
    nodeId: newClientId("n"),
    endpoint: options.endpoint,
    title: options.title,
    input: options.input,
    status: "queued",
    ...(options.cost !== undefined ? { cost: options.cost } : {}),
    extraNodeIds: [],
    origin: options.origin,
    ...(options.review ? { review: options.review } : {}),
    createdAt: Date.now(),
  };
  const anchors = (options.near ?? []).filter((id) => napkin.nodes[id]);
  const position = placeNear(napkin, { w: NODE_WIDTH.media, h: 300 }, { anchorIds: anchors, seed: record.nodeId });
  await applyToNapkin(
    options.napkinId,
    [{ op: "addNode", node: { id: record.nodeId, kind: "media", x: position.x, y: position.y, title: options.title, text: options.prompt, gen: genState(record), origin: options.origin, createdAt: Date.now() } }],
    options.origin,
  );
  state().records.set(record.id, record);
  try {
    record.input = (await resolveInputs(options.napkinId, options.input)) as Record<string, unknown>;
    record.handle = await fal.submit(options.endpoint, record.input);
    if (record.cost) await recordSpend(record.cost);
    await persist(options.napkinId);
    poll(record);
  } catch (error) {
    await finish(record, "failed", error instanceof Error ? error.message : String(error));
  }
  return record;
}

export async function cancelGeneration(napkinId: string, id: string): Promise<void> {
  const record = await getGeneration(napkinId, id);
  if (!record || (record.status !== "queued" && record.status !== "running")) return;
  if (record.handle) await fal.cancel(record.handle);
  await finish(record, "cancelled");
}

/* ── polling ───────────────────────────────────────────────────── */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function poll(record: GenerationRecord): void {
  const s = state();
  if (s.polling.has(record.id) || !record.handle) return;
  s.polling.add(record.id);
  void (async () => {
    let lastShown = "";
    let failures = 0;
    try {
      while (record.status === "queued" || record.status === "running") {
        if (Date.now() - record.createdAt > MAX_RUN_MS) {
          await fal.cancel(record.handle!);
          await finish(record, "failed", "Timed out after 45 minutes.");
          return;
        }
        let current: fal.QueueStatus;
        try {
          current = await fal.status(record.handle!);
          failures = 0;
        } catch (error) {
          if (++failures >= 10) {
            await finish(record, "failed", error instanceof Error ? error.message : String(error));
            return;
          }
          await sleep(5000);
          continue;
        }
        if (current.status === "COMPLETED") {
          await complete(record);
          return;
        }
        record.status = current.status === "IN_PROGRESS" ? "running" : "queued";
        const log = current.logs?.at(-1)?.message?.slice(0, 200);
        const shown = `${record.status}|${current.queue_position ?? ""}|${log ?? ""}`;
        if (shown !== lastShown) {
          lastShown = shown;
          await updateNode(record, { gen: genState(record, { ...(current.queue_position !== undefined ? { position: current.queue_position } : {}), ...(log ? { log } : {}) }) });
        }
        await sleep(Date.now() - record.createdAt > 60_000 ? 4000 : 1500);
      }
    } catch (error) {
      console.error("[generations] poll failed", error);
      await finish(record, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    } finally {
      s.polling.delete(record.id);
    }
  })();
}

async function download(url: string): Promise<{ bytes: Buffer; contentType?: string }> {
  if (!url.startsWith("https://")) throw new Error("Output is not an https URL.");
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_DOWNLOAD) throw new Error("Output too large.");
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, contentType: response.headers.get("content-type") ?? undefined };
}

async function complete(record: GenerationRecord): Promise<void> {
  let output: unknown;
  try {
    output = await fal.result(record.handle!);
  } catch (error) {
    await finish(record, "failed", error instanceof Error ? error.message : String(error));
    return;
  }
  // A result can name the same file twice (e.g. as `audio` and in a list).
  const files = fal.outputFiles(output).filter((file, i, all) => all.findIndex((other) => other.url === file.url) === i).slice(0, 8);
  if (!files.length) {
    await finish(record, "failed", `The model returned no files: ${JSON.stringify(output).slice(0, 400)}`);
    return;
  }
  const saved: Array<{ assetId: string; mime: string; fileName: string }> = [];
  for (const file of files) {
    try {
      const { bytes, contentType } = await download(file.url);
      const generic = (value?: string) => !value || value === "application/octet-stream" || value === "binary/octet-stream";
      const served = contentType?.split(";")[0];
      const mime = !generic(file.contentType) ? file.contentType! : !generic(served) ? served! : guessMime(file.fileName ?? new URL(file.url).pathname);
      const ext = path.extname(file.fileName ?? new URL(file.url).pathname) || EXT_BY_MIME[mime] || ".bin";
      const fileName = `${record.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "media"}${ext}`;
      saved.push({ assetId: await saveAsset(record.napkinId, bytes, fileName), mime, fileName });
    } catch (error) {
      console.error("[generations] download failed", error);
    }
  }
  if (!saved.length) {
    await finish(record, "failed", "The outputs could not be downloaded.");
    return;
  }
  const napkin = await getNapkin(record.napkinId);
  const ops: NapkinOp[] = [{ op: "updateNode", id: record.nodeId, patch: { assetId: saved[0].assetId, mime: saved[0].mime, fileName: saved[0].fileName } }];
  const taken = [];
  for (const extra of saved.slice(1)) {
    const id = newClientId("n");
    const position = placeNear(napkin, { w: NODE_WIDTH.media, h: 300 }, { anchorIds: [record.nodeId], seed: id, taken });
    taken.push({ ...position, w: NODE_WIDTH.media, h: 300 });
    record.extraNodeIds.push(id);
    ops.push({
      op: "addNode",
      node: { id, kind: "media", x: position.x, y: position.y, title: record.title, text: napkin.nodes[record.nodeId]?.text ?? "", assetId: extra.assetId, mime: extra.mime, fileName: extra.fileName, gen: genState({ ...record, status: "done", finishedAt: Date.now() }), origin: record.origin, createdAt: Date.now() },
    });
  }
  await applyToNapkin(record.napkinId, ops, record.origin);
  await finish(record, "done");
}

async function finish(record: GenerationRecord, status: GenerationRecord["status"], error?: string): Promise<void> {
  const wasCharged = !!record.handle && record.cost !== undefined;
  record.status = status;
  record.finishedAt = Date.now();
  if (error) record.error = error;
  // Failed and cancelled runs are not charged by fal; take the estimate back.
  if (wasCharged && status !== "done") await recordSpend(-(record.cost ?? 0));
  await updateNode(record, { gen: genState(record) }).catch(() => {});
  await persist(record.napkinId).catch(() => {});
  const s = state();
  for (const resolve of s.waiters.get(record.id) ?? []) resolve();
  s.waiters.delete(record.id);
  for (const hook of s.finishedHooks) {
    try {
      hook(record);
    } catch (hookError) {
      console.error("[generations] finished hook failed", hookError);
    }
  }
}

/** Wait until all these generations finish, or `ms` pass. */
export async function waitFor(napkinId: string, ids: string[], ms: number, signal?: AbortSignal): Promise<GenerationRecord[]> {
  await load(napkinId);
  const s = state();
  const pending = ids
    .map((id) => s.records.get(id))
    .filter((r): r is GenerationRecord => !!r && r.napkinId === napkinId && (r.status === "queued" || r.status === "running"));
  if (pending.length) {
    await Promise.race([
      Promise.all(pending.map((record) => new Promise<void>((resolve) => s.waiters.set(record.id, [...(s.waiters.get(record.id) ?? []), resolve])))),
      sleep(ms),
      ...(signal ? [new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))] : []),
    ]);
  }
  return ids.map((id) => s.records.get(id)).filter((r): r is GenerationRecord => !!r && r.napkinId === napkinId);
}
