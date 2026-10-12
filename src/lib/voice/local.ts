/**
 * The native audio helper (native/mlch-audio), as server code sees it.
 * Server-only.
 *
 * Main runs the helper; requests go through the desktop bridge ("audio"), and
 * its events (model download progress, system audio chunks) come back over
 * parentPort to electron/server.cjs, which calls the handler registered here.
 *
 * - Local transcription: Parakeet on the Neural Engine, model downloaded on
 *   request into ~/Library/Application Support/mlch/models.
 * - System audio: a capture of the Mac's sound output (everything, or one app)
 *   tied to a mulch. Its chunks are transcribed like the microphone's and
 *   enter the mulch as speech from "them"; while one runs, the microphone's
 *   segments in that mulch are "me".
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { submitInput } from "@/lib/agent/jobs";
import { desktopRequest, isDesktop } from "@/lib/desktop/server";
import { log } from "@/lib/log";
import { newClientId } from "@/lib/mulch/ids";
import { appendTranscript, openMulch } from "@/lib/mulch/store";
import type { TranscriptSegment } from "@/lib/mulch/events";
import { getTranscriber } from "./transcriber";

export type ModelState = "unavailable" | "missing" | "downloading" | "present";

export interface LocalStatus {
  /** The helper is in this build and the Mac can run it. */
  installed: boolean;
  model: ModelState;
  /** 0–1 while downloading. */
  progress?: number;
  error?: string;
}

interface SystemSession {
  session: string;
  mulchId: string;
  target: string;
  startedAt: number;
  /** Loudest sample in the last second (0 when nothing plays, or without permission). */
  peak: number;
  /** Chunks are transcribed one after another, in order. */
  queue: Promise<void>;
  chunks: number;
  error?: string;
}

interface AudioState {
  model: ModelState | undefined;
  progress?: number;
  error?: string;
  sessions: Map<string, SystemSession>;
}

type AudioEvent = { event: string; [key: string]: unknown };

type Globals = typeof globalThis & { __mlchAudio?: AudioState; __mlchAudioEvent?: (event: AudioEvent) => void };

function state(): AudioState {
  const g = globalThis as Globals;
  if (!g.__mlchAudio) {
    g.__mlchAudio = { model: undefined, sessions: new Map() };
    g.__mlchAudioEvent = (event) => void receive(event);
  }
  return g.__mlchAudio;
}

/** Folder for audio handed to the helper, and the helper's own chunk folder. */
const INPUT_DIR = path.join(os.tmpdir(), "mlch-audio-in");
const CHUNK_DIR = path.join(os.tmpdir(), "mlch-audio");

async function audio(action: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await desktopRequest("audio", { action, ...payload });
  if (!result.ok) throw new Error(result.error);
  return (result.value ?? {}) as Record<string, unknown>;
}

export async function localStatus(): Promise<LocalStatus> {
  const s = state();
  if (!isDesktop()) return { installed: false, model: "unavailable" };
  try {
    const value = await audio("status");
    if (!value.installed) return { installed: false, model: "unavailable" };
    if (s.model !== "downloading") s.model = value.model === "present" ? "present" : value.downloading ? "downloading" : "missing";
    return { installed: true, model: s.model, ...(s.model === "downloading" ? { progress: s.progress ?? 0 } : {}), ...(s.error ? { error: s.error } : {}) };
  } catch (error) {
    return { installed: false, model: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Starts the model download (about 600 MB); progress shows in localStatus(). */
export async function downloadModel(): Promise<LocalStatus> {
  const s = state();
  if (s.model !== "downloading") {
    await audio("download");
    s.model = "downloading";
    s.progress = 0;
    s.error = undefined;
    log.info("voice", "local model download started");
  }
  return localStatus();
}

/** Text of a WAV through the local model. */
export async function transcribeLocal(audioBlob: Blob): Promise<string> {
  await fs.mkdir(INPUT_DIR, { recursive: true });
  // The extension tells Core Audio the format (generated media can be mp3, m4a, …).
  const ext = { "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac", "audio/flac": ".flac", "audio/ogg": ".ogg" }[audioBlob.type] ?? ".wav";
  const file = path.join(INPUT_DIR, `${newClientId("a")}${ext}`);
  await fs.writeFile(file, new Uint8Array(await audioBlob.arrayBuffer()));
  try {
    return await transcribeLocalFile(file);
  } finally {
    await fs.rm(file, { force: true });
  }
}

export async function transcribeLocalFile(file: string): Promise<string> {
  const value = await audio("transcribe", { path: file });
  return typeof value.text === "string" ? value.text : "";
}

/** Whether the local model can be used right now. */
export async function localReady(): Promise<boolean> {
  const s = state();
  if (s.model === "present") return true;
  return (await localStatus()).model === "present";
}

// System audio ---------------------------------------------------------------

export interface SystemAudioView {
  session: string;
  target: string;
  startedAt: number;
  peak: number;
  chunks: number;
  error?: string;
}

function view(session: SystemSession): SystemAudioView {
  return { session: session.session, target: session.target, startedAt: session.startedAt, peak: session.peak, chunks: session.chunks, ...(session.error ? { error: session.error } : {}) };
}

export function systemAudioFor(mulchId: string): SystemAudioView | undefined {
  for (const session of state().sessions.values()) if (session.mulchId === mulchId) return view(session);
  return undefined;
}

/**
 * Starts capturing the Mac's sound output into a mulch. `target` is "all", an
 * app's bundle id (us.zoom.xos) or a process id. One capture per mulch.
 */
export async function startSystemAudio(mulchId: string, target: string | number = "all"): Promise<SystemAudioView> {
  const existing = systemAudioFor(mulchId);
  if (existing) return existing;
  await openMulch(mulchId);
  const session = newClientId("tap");
  const value = await audio("tap-start", { target, session });
  const entry: SystemSession = { session: String(value.session ?? session), mulchId, target: String(target), startedAt: Date.now(), peak: 0, queue: Promise.resolve(), chunks: 0 };
  state().sessions.set(entry.session, entry);
  log.info("voice", "system audio started", { mulchId, target: String(target) });
  return view(entry);
}

export async function stopSystemAudio(mulchId: string): Promise<boolean> {
  const current = systemAudioFor(mulchId);
  if (!current) return false;
  await audio("tap-stop", { session: current.session }).catch((error) => log.warn("voice", "system audio stop failed", { mulchId, error }));
  const entry = state().sessions.get(current.session);
  // The last chunk (sent on stop) is still transcribed before the session goes.
  await entry?.queue;
  state().sessions.delete(current.session);
  log.info("voice", "system audio stopped", { mulchId, chunks: current.chunks });
  return true;
}

/**
 * Asks macOS for System Audio Recording (onboarding): a capture started and
 * stopped at once raises the prompt the first time. Resolves when it is done.
 */
export async function askSystemAudio(): Promise<void> {
  const session = newClientId("tap");
  const value = await audio("tap-start", { target: "all", session });
  await audio("tap-stop", { session: String(value.session ?? session) });
}

/** Which speaker a microphone segment in this mulch is: "me" while system audio runs. */
export function micSpeaker(mulchId: string): TranscriptSegment["speaker"] {
  return systemAudioFor(mulchId) ? "me" : undefined;
}

function chunkPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.split(path.sep).includes("..")) return undefined;
  const resolved = path.resolve(value);
  return resolved.startsWith(CHUNK_DIR + path.sep) || resolved.startsWith(path.join(os.tmpdir(), "mlch-audio") + path.sep) ? resolved : undefined;
}

async function receive(event: AudioEvent): Promise<void> {
  const s = state();
  switch (event.event) {
    case "model-progress":
      s.model = "downloading";
      s.progress = typeof event.fraction === "number" ? event.fraction : s.progress;
      return;
    case "model-ready":
      s.model = "present";
      s.progress = undefined;
      log.info("voice", "local model ready");
      return;
    case "model-error":
      s.model = "missing";
      s.progress = undefined;
      s.error = typeof event.error === "string" ? event.error : "The download failed.";
      log.warn("voice", "local model download failed", { error: s.error });
      return;
    case "tap-level": {
      const session = s.sessions.get(String(event.session));
      if (session && typeof event.peak === "number") session.peak = event.peak;
      return;
    }
    case "tap-ended": {
      const session = s.sessions.get(String(event.session));
      if (!session) return;
      if (typeof event.error === "string") {
        session.error = event.error;
        log.warn("voice", "system audio ended", { mulchId: session.mulchId, error: event.error });
      }
      s.sessions.delete(session.session);
      return;
    }
    case "chunk": {
      const session = s.sessions.get(String(event.session));
      const file = chunkPath(event.path);
      if (!file) return;
      if (!session) {
        await fs.rm(file, { force: true });
        return;
      }
      const at = typeof event.at === "number" ? event.at : Date.now();
      session.queue = session.queue.then(() => transcribeChunk(session, file, at)).catch((error) => {
        log.warn("voice", "system audio chunk failed", { mulchId: session.mulchId, error });
      });
      return;
    }
  }
}

async function transcribeChunk(session: SystemSession, file: string, at: number): Promise<void> {
  try {
    const entry = await openMulch(session.mulchId);
    const recent = entry.transcript.slice(-6).map((segment) => segment.text).join(" ");
    const started = Date.now();
    const transcriber = await getTranscriber();
    const text = await transcriber.transcribe(new Blob([new Uint8Array(await fs.readFile(file))], { type: "audio/wav" }), { prompt: recent });
    log.info("voice", "system audio chunk transcribed", { mulchId: session.mulchId, ms: Date.now() - started, chars: text.length });
    session.chunks += 1;
    if (!text) return;
    const segment: TranscriptSegment = { id: newClientId("s"), at, text, source: "speech", speaker: "them" };
    await appendTranscript(session.mulchId, segment);
    submitInput(session.mulchId, segment);
  } finally {
    await fs.rm(file, { force: true });
  }
}

/** For tests: feed an event as if it came from main. */
export const __receiveForTests = receive;
export const __stateForTests = state;
