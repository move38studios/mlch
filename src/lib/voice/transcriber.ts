/**
 * Speech to text. Server-only.
 *
 * One interface, two backends: Groq Whisper (the person's key) or Parakeet
 * on this Mac (local.ts, through the native helper). Settings choose; local
 * falls back to Groq while its model is not downloaded.
 */

import { getCredential } from "@/lib/desktop/server";
import { readSettings } from "@/lib/settings";
import { localReady, transcribeLocal } from "./local";

export interface TranscribeOptions {
  /** Recent transcript, so names and terms carry across chunks. */
  prompt?: string;
  signal?: AbortSignal;
}

export interface Transcriber {
  id: string;
  available(): boolean;
  transcribe(audio: Blob, options?: TranscribeOptions): Promise<string>;
}

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

export const groqTranscriber: Transcriber = {
  id: "groq",
  available: () => !!getCredential("groq"),
  async transcribe(audio, options = {}) {
    const key = getCredential("groq");
    if (!key) throw new Error("Add a Groq API key in Settings to use the microphone.");
    const form = new FormData();
    form.append("file", audio, "chunk.wav");
    form.append("model", GROQ_MODEL);
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (options.prompt) form.append("prompt", options.prompt.slice(-800));
    const response = await fetch(GROQ_URL, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: options.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (response.status === 401) throw new Error("Groq rejected the API key. Check it in Settings.");
      throw new Error(`Transcription failed (${response.status}): ${body.slice(0, 200)}`);
    }
    const data = (await response.json()) as { text?: string };
    return cleanTranscript(data.text ?? "");
  },
};

/** Whisper's usual output on near-silence. A chunk that is only one of these is dropped. */
const HALLUCINATIONS = new Set([
  "", "you", "thank you", "thank you.", "thanks for watching", "thanks for watching!", "thank you for watching",
  "thank you for watching.", "bye", "bye.", ".", "...", "so", "okay", "um", "uh", "hmm",
  "subtitles by the amara.org community",
]);

export function cleanTranscript(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return HALLUCINATIONS.has(trimmed.toLowerCase().replace(/[!?]+$/, "")) ? "" : trimmed;
}

export const localTranscriber: Transcriber = {
  id: "local",
  // Checked with localReady() before it is chosen.
  available: () => true,
  async transcribe(audio) {
    return cleanTranscript(await transcribeLocal(audio));
  },
};

/** The transcriber the settings ask for, or Groq when local is not ready. */
export async function getTranscriber(): Promise<Transcriber> {
  const settings = await readSettings();
  if (settings.transcription === "local" && (await localReady().catch(() => false))) return localTranscriber;
  return groqTranscriber;
}
