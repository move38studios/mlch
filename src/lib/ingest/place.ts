/** Adding dropped things to a napkin and reading them in the background. Server-only. */

import path from "node:path";
import { submitIngest } from "@/lib/agent/jobs";
import { newClientId } from "@/lib/napkin/ids";
import { NODE_WIDTH } from "@/lib/napkin/sizes";
import { applyToNapkin, emit } from "@/lib/napkin/store";
import type { NapkinNode, NodeKind } from "@/lib/napkin/types";
import { extractFile, isImage, readLink, saveAsset, saveText } from "./ingest";

/** Card text for a document: its opening, enough to recognise it. */
const EXCERPT = 600;

function excerpt(text: string): string {
  const clean = text.replace(/--- page \d+ ---/g, "").replace(/\s+/g, " ").trim();
  return clean.length > EXCERPT ? `${clean.slice(0, EXCERPT).replace(/\s\S*$/, "")}…` : clean;
}

async function addNode(napkinId: string, kind: NodeKind, at: { x: number; y: number }, fields: Partial<NapkinNode>): Promise<NapkinNode> {
  const node: NapkinNode = {
    id: newClientId("n"),
    kind,
    x: Math.round(at.x - NODE_WIDTH[kind] / 2),
    y: Math.round(at.y - 40),
    text: "",
    origin: "user",
    createdAt: Date.now(),
    ...fields,
  };
  await applyToNapkin(napkinId, [{ op: "addNode", node }], "user");
  return node;
}

function failed(napkinId: string, nodeId: string, message: string) {
  void applyToNapkin(napkinId, [{ op: "updateNode", id: nodeId, patch: { text: message } }], "ingest");
}

export async function addFile(napkinId: string, bytes: Buffer, fileName: string, at: { x: number; y: number }): Promise<NapkinNode> {
  const assetId = await saveAsset(napkinId, bytes, fileName);
  const name = path.basename(fileName).slice(0, 200);
  if (isImage(fileName)) return addNode(napkinId, "image", at, { assetId, fileName: name });
  const node = await addNode(napkinId, "doc", at, { assetId, fileName: name, title: name, text: "Reading…" });
  void (async () => {
    const text = await extractFile(bytes, fileName);
    if (!text) return failed(napkinId, node.id, "No text could be read from this file.");
    await saveText(napkinId, assetId, text);
    await applyToNapkin(napkinId, [{ op: "updateNode", id: node.id, patch: { text: excerpt(text) } }], "ingest");
    submitIngest(napkinId, node.id, `Reading ${name}`, `File: ${name}\n\n${text}`);
  })().catch((error) => {
    console.error("[ingest] file", error);
    failed(napkinId, node.id, "No text could be read from this file.");
  });
  return node;
}

export async function addLink(napkinId: string, url: string, at: { x: number; y: number }): Promise<NapkinNode> {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const node = await addNode(napkinId, "link", at, { url, title: host, text: "Reading…" });
  void (async () => {
    const page = await readLink(url);
    if (!page) {
      failed(napkinId, node.id, "The page could not be read.");
      await emit(napkinId, { type: "notice", level: "info", message: `Could not read ${host}. The link is kept.` });
      return;
    }
    const assetId = await saveAsset(napkinId, Buffer.from(page.text), "page.md");
    await applyToNapkin(napkinId, [{ op: "updateNode", id: node.id, patch: { title: page.title || host, text: page.summary, assetId } }], "ingest");
    submitIngest(napkinId, node.id, `Reading ${host}`, `Page: ${page.title}\nURL: ${url}\n\n${page.text}`);
  })().catch((error) => {
    console.error("[ingest] link", error);
    failed(napkinId, node.id, "The page could not be read.");
  });
  return node;
}

/** Pasted text: a short one becomes a note; a long one a document that gets read. */
export async function addPastedText(napkinId: string, text: string, at: { x: number; y: number }): Promise<NapkinNode> {
  if (text.length <= 280) return addNode(napkinId, "note", at, { text, userTouched: true });
  const assetId = await saveAsset(napkinId, Buffer.from(text), "pasted.md");
  const node = await addNode(napkinId, "doc", at, { assetId, fileName: "Pasted text", title: "Pasted text", text: excerpt(text) });
  submitIngest(napkinId, node.id, "Reading pasted text", text);
  return node;
}
