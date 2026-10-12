/**
 * Following a shared canvas: a snapshot (at some seq) plus numbered op
 * batches from the room. Batches that arrive before the snapshot wait; ones
 * the snapshot already holds are skipped; a missing number means the viewer
 * fell behind and must fetch the snapshot again.
 */

import { applyOps } from "@/lib/mulch/ops";
import type { Mulch, OpBatch } from "@/lib/mulch/types";

export interface Feed {
  mulch?: Mulch;
  /** The last batch applied (or held by the snapshot). */
  seq: number;
  /** Batches waiting for a snapshot. */
  pending: Array<{ seq: number; batch: OpBatch }>;
}

export const emptyFeed: Feed = { seq: 0, pending: [] };

/** Apply the waiting batches that follow on from `feed.seq`, in order. */
function drain(feed: Feed): { feed: Feed; added: string[]; gap: boolean } {
  let { mulch, seq } = feed;
  const added: string[] = [];
  const pending = [...feed.pending].sort((a, b) => a.seq - b.seq).filter((item) => item.seq > seq);
  while (mulch && pending.length && pending[0].seq === seq + 1) {
    const { batch } = pending.shift()!;
    mulch = applyOps(mulch, batch.ops, batch.at);
    for (const op of batch.ops) if (op.op === "addNode") added.push(op.node.id);
    seq += 1;
  }
  return { feed: { mulch, seq, pending }, added, gap: !!mulch && pending.length > 0 };
}

/** A snapshot arrived (with the seq it holds). */
export function withSnapshot(feed: Feed, mulch: Mulch, seq: number): { feed: Feed; added: string[]; gap: boolean } {
  return drain({ mulch, seq, pending: feed.pending });
}

/** A batch arrived. `gap`: some batch before it never came; fetch the snapshot again. */
export function withBatch(feed: Feed, seq: number, batch: OpBatch): { feed: Feed; added: string[]; gap: boolean } {
  if (seq <= feed.seq && feed.mulch) return { feed, added: [], gap: false };
  return drain({ ...feed, pending: [...feed.pending, { seq, batch }] });
}
