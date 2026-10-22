/**
 * Names and terms mlch learns so speech comes out right ("Fco", not "EFCO").
 * Kept in `<library>/words.json`: each word, how it was misheard when known,
 * and whether it is for all work or one project. Learned from the person's
 * corrections (the AI's remember_word, their edits of speech) or added by
 * hand in Settings; never required. Server-only.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { libraryDir } from "@/lib/desktop/server";
import { atomicWriteFile } from "@/lib/mulch/store";
import { newClientId } from "@/lib/mulch/ids";
import { log } from "@/lib/log";

export interface Word {
  id: string;
  /** As it should be written. */
  term: string;
  /** How speech recognition got it wrong, when known. */
  heard?: string[];
  /** For one project only; absent: all work. */
  project?: string;
  /** How it was learned. */
  from: "correction" | "edit" | "person";
  at: number;
}

const MAX_WORDS = 500;
const file = () => path.join(libraryDir(), "words.json");

let cache: { root: string; words: Word[] } | undefined;

export async function readWords(): Promise<Word[]> {
  const root = libraryDir();
  if (cache?.root === root) return cache.words;
  let words: Word[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(file(), "utf8")) as unknown;
    if (Array.isArray(parsed)) words = parsed.filter((w): w is Word => !!w && typeof (w as Word).term === "string" && typeof (w as Word).id === "string");
  } catch {
    // None yet.
  }
  cache = { root, words };
  return words;
}

async function save(words: Word[]): Promise<void> {
  cache = { root: libraryDir(), words };
  await atomicWriteFile(file(), JSON.stringify(words, null, 1));
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Adds a word, or merges how it was heard into the one already there (same term and project). */
export async function addWord(input: { term: string; heard?: string[]; project?: string; from: Word["from"] }): Promise<Word | undefined> {
  const term = input.term.trim().replace(/\s+/g, " ");
  if (!term || term.length > 80) return undefined;
  const heard = [...new Set((input.heard ?? []).map((h) => h.trim().replace(/\s+/g, " ")).filter((h) => h && !same(h, term) && h.length <= 80))];
  const words = [...(await readWords())];
  const existing = words.find((w) => same(w.term, term) && (w.project ?? "") === (input.project ?? ""));
  if (existing) {
    const merged = [...new Set([...(existing.heard ?? []), ...heard])];
    // The person's spelling wins (case included).
    const updated: Word = { ...existing, term, ...(merged.length ? { heard: merged } : {}), at: Date.now() };
    words[words.indexOf(existing)] = updated;
    await save(words);
    return updated;
  }
  const word: Word = { id: newClientId("w"), term, ...(heard.length ? { heard } : {}), ...(input.project ? { project: input.project } : {}), from: input.from, at: Date.now() };
  words.push(word);
  // The oldest go first when there are too many.
  await save(words.sort((a, b) => b.at - a.at).slice(0, MAX_WORDS));
  log.info("words", "Learned a word", { from: input.from, project: input.project });
  return word;
}

export async function removeWord(id: string): Promise<void> {
  const words = await readWords();
  await save(words.filter((w) => w.id !== id));
}

/** The words for work in a project (its own and those for all work), or for all work. */
export async function wordsFor(project?: string): Promise<Word[]> {
  return (await readWords()).filter((w) => !w.project || w.project === project);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Known mishearings replaced by the word (whole words, any case). */
export function fixHeard(text: string, words: Word[]): string {
  let out = text;
  for (const word of words) {
    for (const heard of word.heard ?? []) {
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(heard)}(?![\\p{L}\\p{N}])`, "giu"), word.term);
    }
  }
  return out;
}

/** The words as one line for a transcriber's prompt or a model's context; empty when none. */
export function wordList(words: Word[], max = 60): string {
  return words
    .slice(0, max)
    .map((w) => w.term)
    .join(", ");
}

/** For a prompt: the words to spell this way, and what they were misheard as. */
export function wordsBlock(words: Word[]): string {
  if (!words.length) return "";
  const lines = words.slice(0, 120).map((w) => `- ${w.term}${w.heard?.length ? ` (misheard as ${w.heard.map((h) => `"${h}"`).join(", ")})` : ""}`);
  return `<words>\nNames and terms the person uses; speech is transcribed and may get them wrong. Write them this way:\n${lines.join("\n")}\n</words>\n\n`;
}

/**
 * Words the person changed when editing text that came from speech: a short
 * run of words replaced by another short run (a name or a term, not a rewrite).
 * Each pair is [heard, term].
 */
export function corrections(before: string, after: string): Array<[string, string]> {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  // Too different: a rewrite, not a correction.
  if (Math.abs(a.length - b.length) > 3 || a.length > 400) return [];
  const strip = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const heard = a.slice(start, endA).map(strip).filter(Boolean).join(" ");
  const term = b.slice(start, endB).map(strip).filter(Boolean).join(" ");
  if (!heard || !term || same(heard, term)) return [];
  if (heard.split(" ").length > 3 || term.split(" ").length > 3) return [];
  // A name or term: written with a capital, a digit, or not a plain lowercase word.
  if (!/[\p{Lu}\p{N}]/u.test(term)) return [];
  return [[heard, term]];
}
