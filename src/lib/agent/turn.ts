/**
 * The person's turn: what they did since their last instruction (comments on
 * items, notes they added, their edits and removals), handed to the AI with
 * their next instruction. Comments never act by themselves; they wait for this.
 * Server-only.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { JobStatus } from "@/lib/mulch/events";
import { mulchDir } from "@/lib/mulch/store";
import type { Mulch, MulchComment, MulchNode, OpBatch } from "@/lib/mulch/types";

const MAX_ITEMS = 40;
/** The log is read from its end: enough for a session's changes. */
const LOG_TAIL = 4 * 1024 * 1024;

function line(text: string, max = 300): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function commentLine(mulch: Mulch, comment: MulchComment, note = ""): string {
  const node = mulch.nodes[comment.nodeId];
  const where = comment.at?.slide ? ` (slide ${comment.at.slide})` : "";
  const quote = comment.at?.quote ? ` on "${line(comment.at.quote, 200)}"` : "";
  return `- ${comment.id} on ${itemLine(node)}${where}${quote}${note}\n  "${line(comment.text, 1500)}"`;
}

function itemLine(node: Pick<MulchNode, "id" | "kind" | "title" | "text">): string {
  return `${node.id} [${node.kind}]${node.title ? ` "${line(node.title, 120)}"` : ""}${node.text ? `: ${line(node.text)}` : ""}`;
}

/** When the person last sent an instruction (their last turn), before this job. */
export function lastTurnAt(jobs: Iterable<JobStatus>, excludeId?: string): number | undefined {
  let at: number | undefined;
  for (const job of jobs) {
    if (job.id === excludeId || job.retry?.kind !== "command" || job.retry.comment || !job.queuedAt) continue;
    at = Math.max(at ?? 0, job.queuedAt);
  }
  return at;
}

/** Comments still open on items that are there. */
export function openComments(mulch: Mulch): MulchComment[] {
  return Object.values(mulch.comments ?? {})
    .filter((comment) => !comment.resolvedAt && mulch.nodes[comment.nodeId])
    .sort((a, b) => a.createdAt - b.createdAt);
}

async function readLog(mulchId: string): Promise<OpBatch[]> {
  const file = path.join(mulchDir(mulchId), "events.jsonl");
  let text: string;
  try {
    const handle = await fs.open(file, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - LOG_TAIL);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
      // A tail starts mid-line: drop the partial first line.
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((raw) => {
      try {
        return [JSON.parse(raw) as OpBatch];
      } catch {
        return [];
      }
    });
}

export interface Turn {
  /** The block for the instruction's prompt; empty when there is nothing. */
  block: string;
  /** Comments it hands over (to mark as sent). */
  commentIds: string[];
}

/**
 * Everything the person did since `since` (their last turn), and every open
 * comment. With no earlier turn: the comments and what they added.
 */
export async function yourTurn(mulch: Mulch, since: number | undefined, alone: ReadonlySet<string> = new Set()): Promise<Turn> {
  // Comments being acted on by themselves are left to their own job.
  const comments = openComments(mulch).filter((comment) => !alone.has(comment.id));
  const sections: string[] = [];
  if (comments.length) {
    const lines = comments.slice(0, MAX_ITEMS).map((comment) => commentLine(mulch, comment, since === undefined || comment.createdAt > since ? "" : " (from before, still open)"));
    sections.push(`Comments on items (each about the item it is on):\n${lines.join("\n")}`);
  }
  // Notes and other items the person added (before a first instruction: all of theirs).
  const added = Object.values(mulch.nodes).filter((node) => node.origin === "user" && node.createdAt > (since ?? 0));
  if (added.length) sections.push(`Added by the person:\n${added.slice(0, MAX_ITEMS).map((node) => `- ${itemLine(node)}`).join("\n")}`);
  if (since !== undefined) {
    // Their edits and removals, from the log (moves and sizes left out).
    const known = new Map<string, Pick<MulchNode, "id" | "kind" | "title" | "text">>();
    const edited = new Set<string>();
    const removed = new Map<string, Pick<MulchNode, "id" | "kind" | "title" | "text">>();
    for (const batch of await readLog(mulch.id)) {
      for (const op of batch.ops) {
        if (op.op === "addNode") known.set(op.node.id, op.node);
        if (op.op === "updateNode") {
          const before = known.get(op.id);
          if (before && (op.patch.text != null || op.patch.title != null)) known.set(op.id, { ...before, ...(op.patch.text != null ? { text: op.patch.text } : {}), ...(op.patch.title != null ? { title: op.patch.title } : {}) });
        }
        if (batch.origin !== "user" || batch.at <= since) continue;
        if (op.op === "updateNode" && (op.patch.text != null || op.patch.title != null) && !added.some((node) => node.id === op.id)) edited.add(op.id);
        if (op.op === "removeNode") {
          const gone = known.get(op.id);
          if (gone) removed.set(op.id, gone);
        }
      }
    }
    const edits = [...edited].filter((id) => mulch.nodes[id]).map((id) => `- ${itemLine(mulch.nodes[id])}`);
    if (edits.length) sections.push(`Edited by the person (as they are now):\n${edits.slice(0, MAX_ITEMS).join("\n")}`);
    const gone = [...removed.values()].filter((node) => !mulch.nodes[node.id]).map((node) => `- ${itemLine(node)}`);
    if (gone.length) sections.push(`Removed by the person:\n${gone.slice(0, MAX_ITEMS).join("\n")}`);
  }
  if (!sections.length) return { block: "", commentIds: [] };
  return {
    block:
      `<your_turn>\nWhat the person did since their last instruction. Take it all into account in this instruction. ` +
      `For each comment, act on it as the instruction allows (on the item it is on), then close it with resolve_comment saying in a few words what you did; ` +
      `leave a comment open only if it needs the person, and say why. If the instruction only names what was handed over ("2 comments, 1 note"), act on the comments and notes as they ask.\n\n${sections.join("\n\n")}\n</your_turn>\n\n`,
    commentIds: comments.map((comment) => comment.id),
  };
}

/** One comment the person asked to be acted on now, by itself (the rest of their turn keeps waiting). */
export function commentNow(mulch: Mulch, commentId: string): Turn {
  const comment = mulch.comments?.[commentId];
  if (!comment || comment.resolvedAt || !mulch.nodes[comment.nodeId]) return { block: "", commentIds: [] };
  return {
    block:
      `<comment_now>\nThe person asked for this comment to be acted on now, by itself: act on it (on the item it is on), then close it with resolve_comment saying in a few words what you did; ` +
      `leave it open only if it needs the person, and say why. Their other comments and notes wait for their next instruction.\n\n${commentLine(mulch, comment)}\n</comment_now>\n\n`,
    commentIds: [comment.id],
  };
}
