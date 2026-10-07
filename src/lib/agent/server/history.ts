/**
 * Seeding a fresh vendor session with the chat so far. Server-only.
 *
 * Used when there is no session to resume: the first turn on a harness, a
 * switch between harnesses mid-chat, a Claude session that no longer exists,
 * or a Codex app-server that restarted and lost its (ephemeral) threads.
 */

import type { HarnessTurnParams } from "../types";

/** Keep the replay well inside any model's context; the newest turns matter most. */
export const HISTORY_CHAR_BUDGET = 24_000;

/**
 * `prompt` preceded by the earlier conversation, cut to the budget when it
 * does not all fit. Returns `prompt` unchanged when there is no history.
 *
 * What is kept, in order: the last two messages (what the new one answers),
 * then the user's messages newest first, then the agent's replies. The user's
 * words carry their instructions and preferences, often stated once near the
 * start; the replies only summarise tool calls, which are not replayed anyway.
 */
export function withConversationHistory(
  history: HarnessTurnParams["history"],
  prompt: string,
  budget: number = HISTORY_CHAR_BUDGET,
): string {
  const turns = history.filter((turn) => turn.text.trim().length > 0);
  if (turns.length === 0) return prompt;

  const lines = turns.map((turn) => {
    const line = `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text.trim()}`;
    return line.length > budget ? `${line.slice(0, budget)}…` : line;
  });
  const newestFirst = turns.map((_, i) => turns.length - 1 - i);
  const order = [
    ...newestFirst.slice(0, 2),
    ...newestFirst.slice(2).filter((i) => turns[i].role === "user"),
    ...newestFirst.slice(2).filter((i) => turns[i].role !== "user"),
  ];
  const kept = new Set<number>();
  let used = 0;
  for (const i of order) {
    if (kept.size > 0 && used + lines[i].length > budget) continue;
    kept.add(i);
    used += lines[i].length;
  }

  const dropped = turns.length - kept.size;
  const note =
    dropped > 0
      ? `(${dropped} earlier message${dropped === 1 ? "" : "s"} omitted.)\n`
      : "";
  return [
    "<conversation_history>",
    "Earlier messages in this chat, for context. The canvas may have changed since; " +
      "the canvas in the current message is authoritative.",
    `${note}${lines.filter((_, i) => kept.has(i)).join("\n\n")}`,
    "</conversation_history>",
    "",
    prompt,
  ].join("\n");
}
