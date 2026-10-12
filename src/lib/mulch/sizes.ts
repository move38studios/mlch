import { hasThumbnail } from "@/lib/artifacts/thumbnails";
/**
 * Node footprints in flow units. Fallbacks only: a node the canvas has
 * rendered stores its measured w/h, and rectOf prefers that.
 */

import type { MulchNode, NodeKind } from "./types";

export const NODE_WIDTH: Record<NodeKind, number> = {
  idea: 240,
  question: 200,
  search: 280,
  definition: 260,
  example: 260,
  doc: 260,
  link: 280,
  image: 260,
  writeup: 320,
  artifact: 320,
  media: 320,
  note: 220,
  ref: 240,
};

const FALLBACK_HEIGHT: Record<NodeKind, number> = {
  idea: 90,
  question: 120,
  search: 150,
  definition: 130,
  example: 120,
  doc: 140,
  link: 150,
  image: 200,
  writeup: 220,
  artifact: 240,
  media: 300,
  note: 120,
  ref: 100,
};

/** Artifact cards with a live preview are taller. */
export function artifactHeight(docPath?: string): number {
  return docPath && (/\.(html|svg|png|jpg)$/.test(docPath) || hasThumbnail(docPath)) ? 400 : 200;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Height guess from text length, for a node the canvas has not measured yet. */
export function estimateHeight(kind: NodeKind, text: string, title?: string): number {
  const width = NODE_WIDTH[kind];
  const charsPerLine = Math.max(20, Math.floor((width - 32) / 7));
  const lines = Math.ceil((text.length || 1) / charsPerLine) + (title ? 1 : 0);
  return Math.max(FALLBACK_HEIGHT[kind], Math.min(420, 40 + lines * 20));
}

export function rectOf(node: Pick<MulchNode, "kind" | "x" | "y" | "w" | "h" | "text" | "title" | "docPath">): Rect {
  return {
    x: node.x,
    y: node.y,
    w: node.w ?? NODE_WIDTH[node.kind],
    h: node.h ?? (node.kind === "artifact" ? artifactHeight(node.docPath) : estimateHeight(node.kind, node.text, node.title)),
  };
}

export const overlaps = (a: Rect, b: Rect, gap = 0) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
