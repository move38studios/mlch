import type { JobStatus } from "@/lib/mulch/events";
import type { Mulch } from "@/lib/mulch/types";
import { unsentComments } from "./Comments";

/** What the person did since their last instruction, as the chip by the input says it ("3 comments, 2 notes"). */
export function pendingTurn(mulch: Mulch | undefined, jobs: Record<string, JobStatus>): { comments: number; notes: number; label: string } {
  let since = 0;
  for (const job of Object.values(jobs)) if (job.retry?.kind === "command" && job.queuedAt) since = Math.max(since, job.queuedAt);
  const comments = unsentComments(mulch).length;
  const notes = Object.values(mulch?.nodes ?? {}).filter((node) => node.kind === "note" && node.origin === "user" && node.createdAt > since && node.text.trim()).length;
  const parts = [comments ? `${comments} ${comments === 1 ? "comment" : "comments"}` : "", notes ? `${notes} ${notes === 1 ? "note" : "notes"}` : ""].filter(Boolean);
  return { comments, notes, label: parts.join(", ") };
}
