/**
 * Reading a video file for the canvas: what is shown and what is said.
 *
 * With a Gemini key, Gemini watches it (pictures, speech, music and on-screen
 * text in one go; the file goes to Google). Otherwise, or when Gemini fails,
 * on this Mac: the sound goes to the person's transcriber (Parakeet here, or
 * Groq in pieces under its size limit), and the pictures are left for the AI
 * to look at (media_view). Every way that fails says why, so the card and
 * the AI can say plainly what was and wasn't read. Server-only.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getCredential, isDesktop } from "@/lib/desktop/server";
import { log } from "@/lib/log";
import { groqTranscriber } from "@/lib/voice/transcriber";
import { helperExtractAudio, localReady, mediaInfo, transcribeLocalFile } from "@/lib/voice/local";
import { geminiAvailable } from "./gemini";

const MODEL = process.env.MLCH_GEMINI_MODEL || "gemini-flash-latest";
const API = "https://generativelanguage.googleapis.com";
/** Gemini's own limit for one uploaded file. */
const GEMINI_MAX_BYTES = 2 * 1024 ** 3;
/** Groq takes 25 MB per request; m4a sound runs about 1 MB a minute, so 15-minute pieces stay well under. */
const GROQ_MAX_BYTES = 25 * 1024 * 1024;
const GROQ_PIECE_S = 15 * 60;

const WATCH_PROMPT = `Watch this video and write, in its language, in markdown:
## Summary
3-6 lines: what it is, who made it or speaks if that is clear, the main points.
## What is shown
Scene by scene, each starting with its time [mm:ss]: what is on screen, and any text shown, quoted exactly.
## What is said
What is said, as paragraphs, each starting with its time [mm:ss] (and the speaker's name when clear). If there is no speech, say so, and describe the music or sound.`;

export interface VideoReading {
  /** What was learned, as text for the canvas and the AI. */
  text: string;
  /** How it was read ("Gemini", "transcribed on this Mac"). */
  how: string[];
  /** What could not be read, and why, in plain words. */
  missing: string[];
  /** The pictures still need looking at (no Gemini): the AI should use media_view. */
  picturesUnread: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Gemini watches a local video file: upload, wait until it is processed, ask, then delete it there. */
export async function geminiWatchFile(file: string, mime: string, signal?: AbortSignal): Promise<string> {
  const key = getCredential("gemini");
  if (!key) throw new Error("No Gemini key.");
  const bytes = await fs.readFile(file);
  if (bytes.length > GEMINI_MAX_BYTES) throw new Error("The video is over Gemini's 2 GB limit.");
  const deadline = signal ?? AbortSignal.timeout(20 * 60_000);
  const start = await fetch(`${API}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: path.basename(file).slice(0, 100) } }),
    signal: deadline,
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) throw new Error(`Gemini didn't take the upload (${start.status}${await start.text().then((t) => `: ${t.slice(0, 160)}`).catch(() => "")}).`);
  const uploaded = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "Content-Length": String(bytes.length) },
    body: new Uint8Array(bytes),
    signal: deadline,
  });
  const info = (await uploaded.json().catch(() => ({}))) as { file?: { name?: string; uri?: string; state?: string } };
  const name = info.file?.name;
  if (!uploaded.ok || !name || !info.file?.uri) throw new Error(`Uploading to Gemini failed (${uploaded.status}).`);
  try {
    // A video is processed before it can be watched.
    let state = info.file.state;
    const poll = Number(process.env.MLCH_GEMINI_POLL_MS) || 3000;
    for (let waited = 0; state === "PROCESSING"; waited += poll) {
      if (waited > 15 * 60_000) throw new Error("Gemini took too long to process the video.");
      await new Promise((resolve) => setTimeout(resolve, poll));
      const polled = (await (await fetch(`${API}/v1beta/${name}`, { headers: { "x-goog-api-key": key }, signal: deadline })).json()) as { state?: string; error?: { message?: string } };
      state = polled.state;
      if (state === "FAILED") throw new Error(`Gemini couldn't process the video${polled.error?.message ? `: ${polled.error.message}` : "."}`);
    }
    const response = await fetch(`${API}/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts: [{ file_data: { mime_type: mime, file_uri: info.file.uri } }, { text: WATCH_PROMPT }] }] }),
      signal: deadline,
    });
    const body = (await response.json().catch(() => ({}))) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? `Gemini answered ${response.status}.`);
    const text = (body.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini returned nothing for this video.");
    return text;
  } finally {
    void fetch(`${API}/v1beta/${name}`, { method: "DELETE", headers: { "x-goog-api-key": key } }).catch(() => {});
  }
}

/**
 * What is said in a recording or video file, on this Mac or by Groq (whole when it fits, else
 * its sound in pieces); throws with the reason when neither can.
 */
export async function transcribeMedia(file: string, duration: number, mime = "audio/mp4"): Promise<{ text: string; how: string }> {
  if (await localReady().catch(() => false)) return { text: await transcribeLocalFile(file), how: "speech transcribed on this Mac" };
  if (!getCredential("groq")) throw new Error("no transcription is set up (Settings: on this Mac, or a Groq key)");
  const size = (await fs.stat(file)).size;
  if (mime.startsWith("audio/") && size <= GROQ_MAX_BYTES) {
    const text = await groqTranscriber.transcribe(new Blob([new Uint8Array(await fs.readFile(file))], { type: mime }));
    return { text, how: "speech transcribed by Groq" };
  }
  if (!isDesktop()) throw new Error("the sound can only be taken out of a video in the desktop app");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlch-video-"));
  try {
    const texts: string[] = [];
    const pieces = Math.max(1, Math.ceil(duration / GROQ_PIECE_S));
    for (let i = 0; i < pieces; i++) {
      const part = pieces > 1 ? { start: i * GROQ_PIECE_S, length: GROQ_PIECE_S } : undefined;
      const sound = await helperExtractAudio(file, path.join(dir, `${i}.m4a`), part);
      if (sound.bytes > GROQ_MAX_BYTES) throw new Error("the sound is too big for Groq even in pieces");
      const text = await groqTranscriber.transcribe(new Blob([new Uint8Array(await fs.readFile(sound.path))], { type: "audio/mp4" }));
      if (text) texts.push(pieces > 1 ? `[${clock(i * GROQ_PIECE_S)}] ${text}` : text);
    }
    return { text: texts.join("\n\n"), how: "speech transcribed by Groq" };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Reads a video file; never throws: what failed is in `missing`. */
export async function readVideoFile(file: string, mime: string, signal?: AbortSignal): Promise<VideoReading> {
  const how: string[] = [];
  const missing: string[] = [];
  if (geminiAvailable()) {
    try {
      const text = await geminiWatchFile(file, mime, signal);
      return { text, how: ["watched by Gemini (pictures and sound)"], missing, picturesUnread: false };
    } catch (error) {
      log.warn("ingest", "Gemini could not watch a video", { error });
      missing.push(`Gemini: ${message(error)}`);
    }
  }
  let info: Awaited<ReturnType<typeof mediaInfo>> | undefined;
  try {
    info = await mediaInfo(file);
  } catch (error) {
    missing.push(`its length and sound could not be read here (${message(error)})`);
  }
  const head = info ? `Video, ${clock(info.duration)}${info.width ? `, ${info.width}×${info.height}` : ""}, ${info.audio ? "with sound" : "no sound"}.` : "Video.";
  let said = "";
  if (info && !info.audio) missing.push("speech: the video has no sound");
  else {
    try {
      const result = await transcribeMedia(file, info?.duration ?? 0, mime);
      said = result.text.trim();
      how.push(result.how);
      if (!said) missing.push("speech: none heard (music or silence)");
    } catch (error) {
      missing.push(`speech: ${message(error)}`);
    }
  }
  const text = [head, said ? `What is said:\n${said}` : ""].filter(Boolean).join("\n\n");
  return { text, how, missing, picturesUnread: true };
}

/** The reading as a card's note: how it was read and what wasn't. */
export function readingNote(reading: VideoReading): string {
  const parts = [reading.how.length ? `Read: ${reading.how.join("; ")}.` : "", reading.missing.length ? `Not read: ${reading.missing.join("; ")}.` : ""];
  return parts.filter(Boolean).join(" ");
}
