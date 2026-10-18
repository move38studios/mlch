/**
 * The cold reader: what someone opening a made thing with no context could not
 * follow. A fresh model call that sees only the thing's text: no canvas, no
 * brief, no conversation. The writer can't unknow what it knows, so it does
 * not judge this itself. Server-only.
 */

import { log } from "@/lib/log";
import { htmlText } from "@/lib/search/chunk";
import { modelFor, readSettings } from "@/lib/settings";
import { getHarness } from "./server/harnesses";
import type { AgentToolRuntime } from "./types";

/** The reader's verdict when nothing is in the way. */
export const CLEAR = "Clear.";

const READER = `You are a reader who has just been sent this, with no other context: you have not seen the notes, conversation, sources or files it was made from, and you do not know the people or projects involved beyond what it says.

List every place where you can't follow it as a newcomer:
- a name, company, person, product, acronym or term used as if you knew it (who is "DCBL"? what is "the ICP"?);
- a number or reference that points at something you weren't shown ("the 31", "the call", "my post-its", "as above" with nothing above, "v4.3");
- something missing that a reader needs first: what this is about, for whom, when, where the facts come from;
- a jump in the argument that only makes sense with outside knowledge.

One line each: where (slide or section), the words quoted, and what a newcomer would need. At most 15, most confusing first.
If a newcomer could follow all of it, reply exactly: ${CLEAR}
You get only its words: charts, marks, colours and pictures are not shown to you, so don't report what may be visual. Do not judge style, design, length or whether you agree. Do not rewrite it.`;

const NO_TOOLS: AgentToolRuntime = { definitions: [], execute: async () => ({ ok: false, text: "No tools here.", summary: "", ops: [] }) };

/** A made thing's words in reading order: a deck slide by slide, a page or document as text. */
export function readableText(content: string, fileName: string): string {
  if (!/\.(html?|svg)$/i.test(fileName)) return content;
  const slides = content.split(/<section[^>]*class="slide"[^>]*>/i);
  if (slides.length > 2) {
    return slides
      .slice(1)
      .map((slide, i) => `Slide ${i + 1}: ${htmlText(slide.split(/<\/section>/i)[0])}`)
      .join("\n");
  }
  return htmlText(content);
}

/**
 * What a newcomer could not follow in `text`, or CLEAR. Undefined when the
 * reader could not run (no AI, a failure): the writer goes on without it.
 */
export async function coldRead(text: string, signal?: AbortSignal): Promise<string | undefined> {
  const words = text.trim();
  if (words.length < 200) return CLEAR;
  try {
    const settings = await readSettings();
    let said = "";
    for await (const event of getHarness(settings.harness).runTurn({
      history: [],
      prompt: `<document>\n${words.slice(0, 60_000)}\n</document>`,
      systemPrompt: READER,
      tools: NO_TOOLS,
      model: modelFor(settings, "slow"),
      maxSteps: 2,
      signal: signal ?? new AbortController().signal,
    })) {
      if (event.type === "text-delta") said += event.delta;
      if (event.type === "error") {
        log.warn("agent", "cold reader failed", { code: event.code, message: event.message });
        return undefined;
      }
    }
    return said.trim() || undefined;
  } catch (error) {
    log.warn("agent", "cold reader failed", { error });
    return undefined;
  }
}

/** The reader's verdict as a note on a tool result, for the writer to act on. */
export function coldReadNote(verdict: string | undefined): string {
  if (!verdict) return "";
  if (verdict.startsWith(CLEAR)) return "\n\nCold reader: a newcomer can follow it.";
  return `\n\nCold reader (someone opening it with no context) could not follow:\n${verdict}\nFor each point, in the file: explain it where it first appears, with what you know (the canvas and sources say what DCBL or a person is), or cut it if the thing doesn't need it. Never leave it as it was. If you can't explain something that has to stay, say so to the person with tell. Then write it again; the reader checks again.`;
}
