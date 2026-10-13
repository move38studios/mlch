/**
 * Watching a YouTube video with Gemini (the person's own key): a summary and a
 * transcript with times, so the canvas can use what is said in it. Gemini
 * takes YouTube addresses directly; other video sites are not supported.
 * Server-only.
 */

import { getCredential } from "@/lib/desktop/server";

/** Google's alias for its current fast model. */
const MODEL = process.env.MLCH_GEMINI_MODEL || "gemini-flash-latest";

const PROMPT = `Watch this video and write, in its language, in markdown:
## Summary
3-6 lines: what it is, who speaks, the main points.
## Transcript
What is said, as paragraphs, each starting with its time [mm:ss] (and the speaker's name when clear). Include text shown on screen that matters, in brackets.`;

export function geminiAvailable(): boolean {
  return !!getCredential("gemini");
}

export async function watchVideo(url: string, signal?: AbortSignal): Promise<string> {
  const key = getCredential("gemini");
  if (!key) throw new Error("No Gemini key: add one in Settings to read videos.");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ parts: [{ file_data: { file_uri: url } }, { text: PROMPT }] }] }),
    signal: signal ?? AbortSignal.timeout(600_000),
  });
  const body = (await response.json().catch(() => ({}))) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `Gemini answered ${response.status}.`);
  const text = (body.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("").trim();
  if (!text) throw new Error("Gemini returned nothing for this video.");
  return text;
}
