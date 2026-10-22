/**
 * The words mlch has learned, applied to speech in a mulch: the transcriber
 * is told them (Groq takes a prompt), and known mishearings are replaced in
 * what comes back (any transcriber). Server-only.
 */

import { projectOf } from "@/lib/projects/projects";
import { fixHeard, wordList, wordsFor } from "./words";

/** For one chunk: the transcriber's prompt (the words, then recent speech) and the fix for its text. */
export async function speechWords(mulchId: string, recent: string): Promise<{ prompt: string; fix: (text: string) => string }> {
  const project = await projectOf(mulchId).catch(() => undefined);
  const words = await wordsFor(project?.id).catch(() => []);
  // Whisper reads about 200 tokens of prompt: the words first, then the end of what was said.
  const list = wordList(words).slice(0, 350);
  return {
    prompt: list ? `${list}. ${recent.slice(-400)}` : recent,
    fix: (text) => (words.length ? fixHeard(text, words) : text),
  };
}
