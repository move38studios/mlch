"use client";

/**
 * Voice detection in the page: Silero VAD (MIT, public/vad/silero_vad.onnx)
 * on onnxruntime-web's WebAssembly runtime. It tells speech from typing,
 * music and room noise better than loudness, so the recorder cuts at the end
 * of what was said and sends only speech. Takes 512 samples at 16 kHz; gives
 * the chance that they are speech. If it cannot load, the recorder keeps its
 * loudness check.
 */

import type * as Ort from "onnxruntime-web/wasm";

export const VAD_RATE = 16_000;
export const VAD_WINDOW = 512;

let loading: Promise<Ort.InferenceSession | undefined> | undefined;
let ort: typeof Ort | undefined;

function session(): Promise<Ort.InferenceSession | undefined> {
  loading ??= (async () => {
    try {
      ort = await import("onnxruntime-web/wasm");
      ort.env.wasm.wasmPaths = "/api/vad/";
      ort.env.wasm.numThreads = 1;
      return await ort.InferenceSession.create("/vad/silero_vad.onnx", { executionProviders: ["wasm"] });
    } catch (error) {
      console.warn("[mlch] voice detection unavailable; using loudness", error);
      return undefined;
    }
  })();
  return loading;
}

/** One detector per recording: the model keeps state between windows. */
export class VoiceDetector {
  private state: Ort.Tensor | undefined;
  private busy = false;
  private ready?: Ort.InferenceSession;
  /** The last chance of speech, 0–1; undefined until the model runs. */
  probability: number | undefined;

  static async create(): Promise<VoiceDetector | undefined> {
    const model = await session();
    if (!model || !ort) return undefined;
    const detector = new VoiceDetector();
    detector.ready = model;
    detector.state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    return detector;
  }

  /** Feeds one window (skipped if the last one is still running: it lags by at most a window). */
  push(window: Float32Array): void {
    if (this.busy || !this.ready || !ort || !this.state) return;
    this.busy = true;
    const feeds = {
      input: new ort.Tensor("float32", window, [1, VAD_WINDOW]),
      state: this.state,
      sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(VAD_RATE)]), []),
    };
    void this.ready
      .run(feeds)
      .then((out) => {
        this.probability = (out.output.data as Float32Array)[0];
        this.state = out.stateN;
      })
      .catch(() => undefined)
      .finally(() => {
        this.busy = false;
      });
  }
}
