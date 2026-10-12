/**
 * Link cards: what a `ref` node points at, read live, and which mulches link
 * into a mulch (backlinks). Server-only.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { addFile } from "@/lib/ingest/place";
import { assetPath } from "@/lib/ingest/ingest";
import { newClientId } from "@/lib/mulch/ids";
import { applyToMulch, getMulch, listMulches, mulchDir, peekMulch } from "@/lib/mulch/store";
import type { MulchNode, MulchOp, NodeKind, NodeRef } from "@/lib/mulch/types";
import { getSource, openUrl, readSourceText, sourceFile } from "@/lib/sources/sources";
import { parseNote } from "@/lib/sources/obsidian";

export interface ResolvedRef {
  exists: boolean;
  /** Where the target lives: a mulch's title or a linked folder's name. */
  place: string;
  kind?: NodeKind | "file";
  title?: string;
  /** The opening of the target's text. */
  text?: string;
  /** When the target last changed. */
  updatedAt?: number;
  /** A link that opens it elsewhere (Obsidian). */
  openUrl?: string;
}

const PREVIEW = 700;

/** `full`: the whole text (for the side panel), not just the opening. */
export async function resolveRef(ref: NodeRef, full = false): Promise<ResolvedRef> {
  const limit = full ? 100_000 : PREVIEW;
  if ("mulchId" in ref) {
    const mulch = await peekMulch(ref.mulchId);
    if (!mulch) return { exists: false, place: "" };
    const node = mulch.nodes[ref.itemId];
    if (!node) return { exists: false, place: mulch.title };
    return { exists: true, place: mulch.title, kind: node.kind, title: node.title ?? node.fileName, text: node.text.slice(0, limit), updatedAt: node.updatedAt ?? node.createdAt };
  }
  const source = await getSource(ref.sourceId);
  if (!source) return { exists: false, place: "" };
  const text = await readSourceText(source, ref.path);
  if (text === undefined) return { exists: false, place: source.name };
  const name = ref.path.split("/").pop()!.replace(/\.[^.]+$/, "");
  const note = /\.(md|markdown)$/i.test(ref.path) ? parseNote(text) : undefined;
  return {
    exists: true,
    place: source.name,
    kind: "file",
    title: note?.title ?? name,
    text: (note?.body ?? text).trim().slice(0, limit),
    ...(openUrl(source, ref.path) ? { openUrl: openUrl(source, ref.path) } : {}),
  };
}

export interface Backlink {
  mulchId: string;
  mulchTitle: string;
  /** The link card in that mulch. */
  nodeId: string;
  /** The item here it points at. */
  itemId: string;
}

/** Link cards in other mulches that point into this one. */
export async function backlinks(mulchId: string): Promise<Backlink[]> {
  const out: Backlink[] = [];
  for (const summary of await listMulches()) {
    if (summary.id === mulchId) continue;
    const mulch = await peekMulch(summary.id);
    if (!mulch) continue;
    for (const node of Object.values(mulch.nodes) as MulchNode[]) {
      if (node.ref && "mulchId" in node.ref && node.ref.mulchId === mulchId) out.push({ mulchId: summary.id, mulchTitle: mulch.title, nodeId: node.id, itemId: node.ref.itemId });
    }
  }
  return out;
}

/* ── copies ────────────────────────────────────────────────────── */

/** A copy of another mulch's item for this mulch, its files copied along so it works on its own. Not applied. */
export async function copyItem(toMulchId: string, fromMulchId: string, itemId: string, at: { x: number; y: number }, origin: string): Promise<MulchNode | undefined> {
  const from = await peekMulch(fromMulchId);
  const node = from?.nodes[itemId];
  if (!from || !node) return undefined;
  if (node.assetId) {
    await fs.mkdir(path.join(mulchDir(toMulchId), "assets"), { recursive: true });
    for (const asset of [node.assetId, `${node.assetId.split(".")[0]}.md`]) await fs.copyFile(assetPath(fromMulchId, asset), assetPath(toMulchId, asset)).catch(() => undefined);
  }
  const copy: MulchNode = {
    ...node,
    id: newClientId("n"),
    x: at.x,
    y: at.y,
    groupId: undefined,
    docPath: undefined,
    text: `${node.text}\n\n(From "${from.title}")`,
    origin,
    userTouched: undefined,
    createdAt: Date.now(),
  };
  return JSON.parse(JSON.stringify(copy)) as MulchNode;
}

/**
 * "Bring here": the link card becomes a real item where it stood (a copy of
 * the other mulch's item, or the linked file as a document), keeping its
 * connections.
 */
export async function bringHere(mulchId: string, refNodeId: string): Promise<string | undefined> {
  const mulch = await getMulch(mulchId);
  const card = mulch.nodes[refNodeId];
  if (!card?.ref) return undefined;
  let newId: string | undefined;
  const ops: MulchOp[] = [];
  if ("mulchId" in card.ref) {
    const copy = await copyItem(mulchId, card.ref.mulchId, card.ref.itemId, { x: card.x, y: card.y }, "user");
    if (!copy) return undefined;
    newId = copy.id;
    ops.push({ op: "addNode", node: copy });
  } else {
    const source = await getSource(card.ref.sourceId);
    const file = source && sourceFile(source, card.ref.path);
    if (!file) return undefined;
    newId = (await addFile(mulchId, await fs.readFile(file), path.basename(file), { x: card.x, y: card.y })).id;
  }
  for (const edge of Object.values(mulch.edges)) {
    if (edge.source !== refNodeId && edge.target !== refNodeId) continue;
    ops.push({ op: "addEdge", edge: { ...edge, id: newClientId("e"), source: edge.source === refNodeId ? newId : edge.source, target: edge.target === refNodeId ? newId : edge.target } });
  }
  ops.push({ op: "removeNode", id: refNodeId });
  await applyToMulch(mulchId, ops, "user");
  return newId;
}
