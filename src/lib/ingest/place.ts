/** Adding dropped things to a mulch and reading them in the background. Server-only. */

import { log } from "@/lib/log";
import path from "node:path";
import { submitImage, submitIngest } from "@/lib/agent/jobs";
import { newClientId } from "@/lib/mulch/ids";
import { NODE_WIDTH } from "@/lib/mulch/sizes";
import { applyToMulch, emit } from "@/lib/mulch/store";
import type { MulchNode, NodeKind } from "@/lib/mulch/types";
import { extractFile, isImage, readLink, saveAsset, saveText } from "./ingest";

/** Card text for a document: its opening, enough to recognise it. */
const EXCERPT = 600;

function excerpt(text: string): string {
  const clean = text.replace(/--- page \d+ ---/g, "").replace(/\s+/g, " ").trim();
  return clean.length > EXCERPT ? `${clean.slice(0, EXCERPT).replace(/\s\S*$/, "")}…` : clean;
}

async function addNode(mulchId: string, kind: NodeKind, at: { x: number; y: number }, fields: Partial<MulchNode>): Promise<MulchNode> {
  const node: MulchNode = {
    id: newClientId("n"),
    kind,
    x: Math.round(at.x - NODE_WIDTH[kind] / 2),
    y: Math.round(at.y - 40),
    text: "",
    origin: "user",
    createdAt: Date.now(),
    ...fields,
  };
  await applyToMulch(mulchId, [{ op: "addNode", node }], "user");
  return node;
}

function failed(mulchId: string, nodeId: string, message: string) {
  void applyToMulch(mulchId, [{ op: "updateNode", id: nodeId, patch: { text: message } }], "ingest");
}

export async function addFile(mulchId: string, bytes: Buffer, fileName: string, at: { x: number; y: number }): Promise<MulchNode> {
  const assetId = await saveAsset(mulchId, bytes, fileName);
  const name = path.basename(fileName).slice(0, 200);
  if (isImage(fileName)) {
    const node = await addNode(mulchId, "image", at, { assetId, fileName: name });
    submitImage(mulchId, node.id, `Looking at ${name}`);
    return node;
  }
  const node = await addNode(mulchId, "doc", at, { assetId, fileName: name, title: name, text: "Reading…" });
  void (async () => {
    const text = await extractFile(bytes, fileName);
    if (!text) return failed(mulchId, node.id, "No text could be read from this file.");
    await saveText(mulchId, assetId, text);
    await applyToMulch(mulchId, [{ op: "updateNode", id: node.id, patch: { text: excerpt(text) } }], "ingest");
    submitIngest(mulchId, node.id, `Reading ${name}`, `File: ${name}\n\n${text}`);
  })().catch((error) => {
    log.error("ingest", "file could not be read", { mulchId, fileName, error });
    failed(mulchId, node.id, "No text could be read from this file.");
  });
  return node;
}

export async function addLink(mulchId: string, url: string, at: { x: number; y: number }): Promise<MulchNode> {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const node = await addNode(mulchId, "link", at, { url, title: host, text: "Reading…" });
  void (async () => {
    const page = await readLink(url);
    if (!page) {
      log.warn("ingest", "page unreadable", { mulchId, url });
      failed(mulchId, node.id, "The page could not be read.");
      await emit(mulchId, { type: "notice", level: "info", message: `Could not read ${host}. The link is kept.` });
      return;
    }
    const assetId = await saveAsset(mulchId, Buffer.from(page.text), "page.md");
    await applyToMulch(mulchId, [{ op: "updateNode", id: node.id, patch: { title: page.title || host, text: page.summary, assetId } }], "ingest");
    submitIngest(mulchId, node.id, `Reading ${host}`, `Page: ${page.title}\nURL: ${url}\n\n${page.text}`);
  })().catch((error) => {
    log.error("ingest", "link could not be read", { mulchId, url, error });
    failed(mulchId, node.id, "The page could not be read.");
  });
  return node;
}

/** Pasted text: a short one becomes a note; a long one a document that gets read. */
export async function addPastedText(mulchId: string, text: string, at: { x: number; y: number }): Promise<MulchNode> {
  if (text.length <= 280) return addNode(mulchId, "note", at, { text, userTouched: true });
  const assetId = await saveAsset(mulchId, Buffer.from(text), "pasted.md");
  const node = await addNode(mulchId, "doc", at, { assetId, fileName: "Pasted text", title: "Pasted text", text: excerpt(text) });
  submitIngest(mulchId, node.id, "Reading pasted text", text);
  return node;
}
