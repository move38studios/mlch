/**
 * Copy, paste and duplicate cards. The clipboard carries the cards themselves
 * (their own type, beside plain text for other apps), so they paste into this
 * mulch or another. Pasted cards are the person's own; files come along
 * (`/copies`), connections between copied cards too.
 */

import { newClientId } from "@/lib/mulch/ids";
import { NODE_WIDTH } from "@/lib/mulch/sizes";
import type { Mulch, MulchEdge, MulchNode, MulchOp } from "@/lib/mulch/types";

export const CARDS_TYPE = "application/x-mlch-cards";

export interface CopiedCards {
  v: 1;
  mulchId: string;
  nodes: MulchNode[];
  edges: MulchEdge[];
}

export function copiedCards(mulch: Mulch, ids: Iterable<string>): CopiedCards | undefined {
  const wanted = new Set([...ids].filter((id) => mulch.nodes[id]));
  if (!wanted.size) return undefined;
  return {
    v: 1,
    mulchId: mulch.id,
    nodes: [...wanted].map((id) => mulch.nodes[id]),
    edges: Object.values(mulch.edges).filter((edge) => wanted.has(edge.source) && wanted.has(edge.target)),
  };
}

/** The cards as text, for pasting outside mlch. */
export function cardsText(cards: CopiedCards): string {
  return [...cards.nodes]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((node) => [node.title, node.text, node.url].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");
}

export function readCopiedCards(data: DataTransfer): CopiedCards | undefined {
  if (!data.types.includes(CARDS_TYPE)) return undefined;
  try {
    const cards = JSON.parse(data.getData(CARDS_TYPE)) as CopiedCards;
    return cards?.v === 1 && typeof cards.mulchId === "string" && Array.isArray(cards.nodes) && Array.isArray(cards.edges) ? cards : undefined;
  } catch {
    return undefined;
  }
}

/** Where the copies go: centred on a point, or moved by an offset from the originals. */
export type PasteAt = { center: { x: number; y: number } } | { offset: { x: number; y: number } };

/** The ops that add copies of the cards to `toMulchId`, after copying their files there; and the copies' ids. */
export async function pasteOps(toMulchId: string, cards: CopiedCards, at: PasteAt): Promise<{ ops: MulchOp[]; ids: string[] }> {
  const assets = cards.nodes.flatMap((node) => [node.assetId, node.poster].filter((x): x is string => !!x));
  const docPaths = cards.nodes.flatMap((node) => (node.docPath ? [node.docPath] : []));
  let moved: Record<string, string> = {};
  if (docPaths.length || (assets.length && cards.mulchId !== toMulchId)) {
    const response = await fetch(`/api/mulches/${toMulchId}/copies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: cards.mulchId, assets, docPaths }),
    });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || `Could not copy the files (${response.status})`);
    moved = ((await response.json()) as { docPaths?: Record<string, string> }).docPaths ?? {};
  }
  let dx = 0;
  let dy = 0;
  if ("offset" in at) {
    dx = at.offset.x;
    dy = at.offset.y;
  } else {
    const left = Math.min(...cards.nodes.map((node) => node.x));
    const top = Math.min(...cards.nodes.map((node) => node.y));
    const right = Math.max(...cards.nodes.map((node) => node.x + (node.w ?? NODE_WIDTH[node.kind])));
    const bottom = Math.max(...cards.nodes.map((node) => node.y + (node.h ?? 80)));
    dx = at.center.x - (left + right) / 2;
    dy = at.center.y - (top + bottom) / 2;
  }
  const now = Date.now();
  const ids = new Map(cards.nodes.map((node) => [node.id, newClientId("n")]));
  const ops: MulchOp[] = cards.nodes.map((node) => {
    const copy: MulchNode = {
      ...node,
      id: ids.get(node.id)!,
      x: Math.round(node.x + dx),
      y: Math.round(node.y + dy),
      groupId: undefined,
      // A generation still running belongs to the original.
      gen: node.gen?.status === "done" ? node.gen : undefined,
      docPath: node.docPath ? (moved[node.docPath] ?? node.docPath) : undefined,
      origin: "user",
      userTouched: true,
      createdAt: now,
      updatedAt: undefined,
    };
    return { op: "addNode", node: JSON.parse(JSON.stringify(copy)) as MulchNode };
  });
  for (const edge of cards.edges) {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (source && target) ops.push({ op: "addEdge", edge: { ...edge, id: newClientId("e"), source, target, origin: "user", createdAt: now } });
  }
  return { ops, ids: [...ids.values()] };
}
