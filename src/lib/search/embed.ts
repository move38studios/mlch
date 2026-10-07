/**
 * Local text embeddings (multilingual-e5-small, quantised). Server-only.
 *
 * Runs in a worker thread (scripts/embed-worker.mjs) on WebAssembly: the
 * native ONNX runtime crashes inside Electron, so none is loaded. The model
 * (~130 MB) is downloaded once into ~/.mulch/models; nothing else leaves the
 * machine. A worker that fails is replaced on the next request, up to three
 * times; after that, and with MULCH_NO_EMBEDDINGS=1, search is keyword-only.
 */

import path from "node:path";
import type { Worker } from "node:worker_threads";
import { log } from "@/lib/log";

export const EMBED_DIMS = 384;

interface EmbedWorker {
  worker: Worker;
  pending: Map<number, { resolve(v: Float32Array[]): void; reject(e: Error): void }>;
  next: number;
  dead: boolean;
}

const globalState = globalThis as typeof globalThis & { __mulchEmbedWorker?: EmbedWorker; __mulchEmbedFailures?: number };

export function embeddingsEnabled(): boolean {
  return process.env.MULCH_NO_EMBEDDINGS !== "1" && (globalState.__mulchEmbedFailures ?? 0) < 3;
}

function failed(state: EmbedWorker, reason: string): void {
  if (state.dead) return;
  state.dead = true;
  globalState.__mulchEmbedFailures = (globalState.__mulchEmbedFailures ?? 0) + 1;
  log.error("search", "embedding worker failed", { reason, failures: globalState.__mulchEmbedFailures });
  for (const waiter of state.pending.values()) waiter.reject(new Error(reason));
  state.pending.clear();
}

function worker(): EmbedWorker {
  const existing = globalState.__mulchEmbedWorker;
  if (existing && !existing.dead) return existing;
  // Loaded at run time so the bundler leaves the worker file alone.
  const { Worker: WorkerThread } = process.getBuiltinModule("node:worker_threads") as typeof import("node:worker_threads");
  const instance = new WorkerThread(path.join(process.cwd(), "scripts", "embed-worker.mjs"));
  const state: EmbedWorker = { worker: instance, pending: new Map(), next: 1, dead: false };
  instance.on("message", (message: { id: number; vectors?: Float32Array[]; error?: string }) => {
    const waiter = state.pending.get(message.id);
    if (!waiter) return;
    state.pending.delete(message.id);
    if (message.error || !message.vectors) {
      log.warn("search", "embedding failed", { error: message.error?.slice(0, 500) });
      waiter.reject(new Error(message.error ?? "No vectors."));
    } else waiter.resolve(message.vectors);
  });
  instance.on("error", (error) => failed(state, String(error)));
  instance.on("exit", (code) => failed(state, `exited ${code}`));
  instance.unref();
  globalState.__mulchEmbedWorker = state;
  return state;
}

/** e5 wants "passage: " / "query: " prefixes (the worker adds them). Undefined when off, failed or too slow. */
export async function embed(texts: string[], role: "passage" | "query", timeoutMs = 180_000): Promise<Float32Array[] | undefined> {
  if (!embeddingsEnabled()) return undefined;
  if (!texts.length) return [];
  try {
    const w = worker();
    const id = w.next++;
    return await new Promise<Float32Array[]>((resolve, reject) => {
      w.pending.set(id, { resolve, reject });
      w.worker.postMessage({ id, texts, role });
      setTimeout(() => {
        if (w.pending.delete(id)) reject(new Error(`Embedding took longer than ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs).unref?.();
    });
  } catch (error) {
    log.warn("search", "embeddings unavailable", { error: String(error) });
    return undefined;
  }
}
