/**
 * In a call on speakers, the microphone also hears the others. A mic
 * segment that repeats what the Mac's sound output carried a moment before
 * or after is the echo, not the person: drop it.
 */

import type { TranscriptSegment } from "@/lib/mulch/events";

const WINDOW_MS = 12_000;
const SAME = 0.6;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
}

/** Share of the shorter text's words found in the other. */
export function overlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size);
}

export function dropEcho(segments: TranscriptSegment[]): TranscriptSegment[] {
  const theirs = segments.filter((s) => s.speaker === "them");
  return segments.filter((segment) => segment.speaker !== "me" || !theirs.some((other) => Math.abs(other.at - segment.at) < WINDOW_MS && overlap(segment.text, other.text) >= SAME));
}
