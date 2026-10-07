/**
 * Speech to text. Server-only.
 *
 * One interface so the backend can change: Groq Whisper now (user's key),
 * local Parakeet later.
 */

import { getCredential } from "@/lib/desktop/server";

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

export function getTranscriber(): Transcriber {
  return groqTranscriber;
}
