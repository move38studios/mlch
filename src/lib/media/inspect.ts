/**
 * Generated media in a form a model can take in. Server-only.
 *
 * Models see images, not video or sound, so: images as images; video as a
 * few frames plus duration and size; speech transcribed back; any audio's
 * duration and loudness; 3D models rendered from four sides (desktop only).
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { imageForModel } from "@/lib/agent/files";
import { desktopRequest } from "@/lib/desktop/server";
import { getTranscriber } from "@/lib/voice/transcriber";

const run = promisify(execFile);

export interface ModelView {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
}

export type MediaClass = "image" | "video" | "audio" | "model" | "other";

export function mediaClass(mime: string | undefined, fileName = ""): MediaClass {
  const ext = path.extname(fileName).toLowerCase();
  if (mime?.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
  if (mime?.startsWith("video/") || [".mp4", ".webm", ".mov"].includes(ext)) return "video";
  if (mime?.startsWith("audio/") || [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"].includes(ext)) return "audio";
  if (mime?.includes("gltf") || [".glb", ".gltf"].includes(ext)) return "model";
  return "other";
}

async function probe(file: string): Promise<{ duration?: number; width?: number; height?: number; audio: boolean }> {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file], { timeout: 30_000 });
    const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
    const video = data.streams?.find((s) => s.codec_type === "video");
    return {
      duration: data.format?.duration ? Number(data.format.duration) : undefined,
      width: video?.width,
      height: video?.height,
      audio: !!data.streams?.some((s) => s.codec_type === "audio"),
    };
  } catch {
    return { audio: false };
  }
}

async function videoFrames(file: string, duration: number, count = 6): Promise<ModelView["images"]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mulch-frames-"));
  try {
    const images: ModelView["images"] = [];
    for (let i = 0; i < count; i++) {
      const at = Math.max(0, Math.min(duration - 0.05, (duration * (i + 0.5)) / count));
      const out = path.join(dir, `${i}.jpg`);
      await run("ffmpeg", ["-v", "error", "-ss", at.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=768:-2", out], { timeout: 30_000 }).catch(() => undefined);
      const bytes = await fs.readFile(out).catch(() => undefined);
      if (bytes) images.push(await imageForModel(bytes));
    }
    return images;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function loudness(file: string): Promise<string | undefined> {
  try {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { timeout: 60_000 });
    const mean = stderr.match(/mean_volume: (-?[\d.]+) dB/)?.[1];
    const max = stderr.match(/max_volume: (-?[\d.]+) dB/)?.[1];
    return mean ? `mean ${mean} dB, peak ${max} dB` : undefined;
  } catch {
    return undefined;
  }
}

/** `file` is the media on disk; `modelViewUrl` renders a 3D model in the app (desktop only). */
export async function viewForModel(file: string, mime: string | undefined, modelViewUrl?: string): Promise<ModelView> {
  const kind = mediaClass(mime, file);
  if (kind === "image") return { text: "Image.", images: [await imageForModel(await fs.readFile(file))] };
  if (kind === "video") {
    const info = await probe(file);
    const duration = info.duration ?? 5;
    const frames = await videoFrames(file, duration);
    return {
      text: `Video: ${duration.toFixed(1)}s, ${info.width ?? "?"}x${info.height ?? "?"}, ${info.audio ? "with sound" : "no sound"}. ${frames.length} frames sampled evenly, in order.`,
      images: frames,
    };
  }
  if (kind === "audio") {
    const info = await probe(file);
    const level = await loudness(file);
    let transcript = "";
    try {
      const bytes = await fs.readFile(file);
      const transcriber = await getTranscriber();
      if (bytes.length < 20 * 1024 * 1024 && transcriber.available()) {
        transcript = await transcriber.transcribe(new Blob([new Uint8Array(bytes)], { type: mime ?? "audio/mpeg" }));
      }
    } catch {
      transcript = "";
    }
    return {
      text:
        `Audio: ${info.duration ? `${info.duration.toFixed(1)}s` : "unknown length"}${level ? `, ${level}` : ""}. ` +
        (transcript ? `Speech heard in it (transcribed): "${transcript}"` : "No speech recognised (music or sound, or transcription unavailable). You cannot hear it; judge only by these facts."),
      images: [],
    };
  }
  if (kind === "model" && modelViewUrl) {
    const result = await desktopRequest("render", { url: modelViewUrl, steps: 4 });
    if (result.ok) {
      const value = result.value as { images: string[]; errors: string[] };
      return { text: `3D model rendered from 4 sides (turning 90° each).${value.errors.length ? ` Viewer errors: ${value.errors.join("; ")}` : ""}`, images: value.images.map((data) => ({ data, mimeType: "image/png" })) };
    }
    return { text: `3D model; it could not be rendered here (${result.error}).`, images: [] };
  }
  return { text: `File of type ${mime ?? "unknown"}; no preview.`, images: [] };
}
