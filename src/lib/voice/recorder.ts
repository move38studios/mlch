"use client";

/**
 * Microphone capture cut into chunks at pauses. Browser-only.
 *
 * Raw samples come from an AudioWorklet (gapless, unlike restarting a
 * MediaRecorder), a simple energy detector finds speech and pauses, and each
 * chunk with speech in it is encoded as 16 kHz mono WAV for the server.
 *
 * A chunk ends at a pause after at least MIN_CHUNK_MS of audio, at a shorter
 * pause once it is long, or at MAX_CHUNK_MS regardless. Silence-only chunks
 * are dropped, keeping a little pre-roll so the next word's start survives.
 */

export interface RecorderEvents {
  /** A finished chunk with speech in it. */
  onChunk(wav: Blob, startedAt: number): void;
  /** Input level 0-1, about 30 times a second. */
  onLevel?(level: number, speaking: boolean): void;
}

const TARGET_RATE = 16_000;
const FRAME_MS = 20;
const MIN_CHUNK_MS = 1_500;
const PAUSE_MS = 650;
const LONG_CHUNK_MS = 8_000;
const SHORT_PAUSE_MS = 250;
const MAX_CHUNK_MS = 15_000;
const PREROLL_MS = 300;
/** A chunk needs this much speech in it to be sent. */
const MIN_SPEECH_MS = 250;

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("mlch-tap", Tap);
`;

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Average-downsample to the target rate (fine for speech). */
export function downsample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

/**
 * The chunking decision, separate from audio plumbing so it can be tested.
 * Feed it one frame's speech flag at a time; it says when to cut or drop.
 */
export class Chunker {
  chunkMs = 0;
  speechMs = 0;
  silenceMs = 0;

  push(speaking: boolean): "keep" | "cut" | "drop" {
    this.chunkMs += FRAME_MS;
    if (speaking) {
      this.speechMs += FRAME_MS;
      this.silenceMs = 0;
    } else this.silenceMs += FRAME_MS;
    const hasSpeech = this.speechMs >= MIN_SPEECH_MS;
    // No real speech yet: once there is a pause (or a long stretch of noise), drop all but the pre-roll.
    if (!hasSpeech) return this.chunkMs > PREROLL_MS + FRAME_MS && (this.silenceMs >= 500 || this.chunkMs >= MAX_CHUNK_MS) ? "drop" : "keep";
    if (this.chunkMs >= MAX_CHUNK_MS) return "cut";
    if (this.silenceMs >= PAUSE_MS && this.chunkMs >= MIN_CHUNK_MS) return "cut";
    if (this.silenceMs >= SHORT_PAUSE_MS && this.chunkMs >= LONG_CHUNK_MS) return "cut";
    return "keep";
  }

  reset(keptMs = 0) {
    this.chunkMs = keptMs;
    this.speechMs = 0;
    this.silenceMs = keptMs;
  }

  get hasSpeech(): boolean {
    return this.speechMs >= MIN_SPEECH_MS;
  }
}

export class Recorder {
  private context?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private frames: Float32Array[] = [];
  private pending = new Float32Array(0);
  private chunker = new Chunker();
  private chunkStartedAt = 0;
  private noiseFloor = 0.004;

  constructor(private readonly events: RecorderEvents) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.context = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    try {
      await this.context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, "mlch-tap");
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => this.receive(event.data);
    source.connect(this.node);
    this.chunkStartedAt = Date.now();
  }

  /** Stop and send what is left if it has speech. */
  stop(): void {
    if (this.chunker.hasSpeech) this.flush();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.node = undefined;
    this.stream = undefined;
    this.context = undefined;
    this.frames = [];
    this.pending = new Float32Array(0);
    this.chunker.reset();
  }

  private frameSize(): number {
    return Math.round(((this.context?.sampleRate ?? 48_000) * FRAME_MS) / 1000);
  }

  private receive(samples: Float32Array) {
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    const size = this.frameSize();
    let offset = 0;
    for (; offset + size <= merged.length; offset += size) this.frame(merged.subarray(offset, offset + size).slice());
    this.pending = merged.slice(offset);
  }

  private frame(frame: Float32Array) {
    let sum = 0;
    for (const s of frame) sum += s * s;
    const rms = Math.sqrt(sum / frame.length);
    const speaking = rms > Math.max(0.012, this.noiseFloor * 3);
    // Track the background level slowly, only while quiet.
    if (!speaking) this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;
    this.events.onLevel?.(Math.min(1, rms * 8), speaking);

    if (!this.frames.length) this.chunkStartedAt = Date.now() - FRAME_MS;
    this.frames.push(frame);
    const decision = this.chunker.push(speaking);
    if (decision === "cut") this.flush();
    else if (decision === "drop") {
      // Keep only the pre-roll.
      const keep = Math.ceil(PREROLL_MS / FRAME_MS);
      this.frames = this.frames.slice(-keep);
      this.chunker.reset(this.frames.length * FRAME_MS);
      this.chunkStartedAt = Date.now() - this.frames.length * FRAME_MS;
    }
  }

  private flush() {
    const rate = this.context?.sampleRate ?? 48_000;
    const total = this.frames.reduce((n, f) => n + f.length, 0);
    const all = new Float32Array(total);
    let offset = 0;
    for (const f of this.frames) {
      all.set(f, offset);
      offset += f.length;
    }
    const startedAt = this.chunkStartedAt;
    this.frames = [];
    this.chunker.reset();
    if (total) this.events.onChunk(encodeWav(downsample(all, rate, TARGET_RATE), TARGET_RATE), startedAt);
  }
}
