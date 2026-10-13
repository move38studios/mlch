/**
 * Sharing from the app: a made file (a deck, a page) or the whole canvas as a
 * link on share.mlch.app. Server-only.
 *
 *   <mulch>/shares.json   this mulch's shares, with their owner tokens
 *
 * A shared canvas is live while sharing is on: every applied batch is sent
 * to the share (new files first), so people watching see it build up. What
 * goes: the items, their files, made things and write-ups. Links to the
 * person's linked folders go as their title only, never the file.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { log } from "@/lib/log";
import { resolveRef } from "@/lib/links/links";
import { desktopRequest } from "@/lib/desktop/server";
import { hasThumbnail } from "@/lib/artifacts/thumbnails";
import { atomicWriteFile, createMulch, applyToMulch, getMulch, mulchDir, onAfterApply } from "@/lib/mulch/store";
import { newClientId } from "@/lib/mulch/ids";
import { applyOps } from "@/lib/mulch/ops";
import type { Mulch, MulchNode, MulchOp, OpBatch } from "@/lib/mulch/types";
import { readSettings, writeSettings } from "@/lib/settings";
import { shareClient, ShareError, thumbnailPath, type LiveSender, type Manifest, type Share, type ShareKind } from "./client";

export interface ShareRecord extends Share {
  kind: ShareKind;
  /** Artifacts: the file shared. */
  docPath?: string;
  live?: boolean;
  createdAt: number;
}

/** What the page sees (never the owner token). */
export type ShareView = Omit<ShareRecord, "ownerToken">;

interface State {
  senders: Map<string, LiveSender>;
  /** Files already uploaded per share, so live updates send only new ones. */
  uploaded: Map<string, Set<string>>;
  /** Mulch → its live share, or null when it has none (cached). */
  live: Map<string, ShareRecord | null>;
}
const globalState = globalThis as typeof globalThis & { __mlchShares?: State };
function state(): State {
  return (globalState.__mlchShares ??= { senders: new Map(), uploaded: new Map(), live: new Map() });
}

/* ── records ───────────────────────────────────────────────────── */

function recordsFile(mulchId: string): string {
  return path.join(mulchDir(mulchId), "shares.json");
}

export async function readShares(mulchId: string): Promise<ShareRecord[]> {
  try {
    return JSON.parse(await fs.readFile(recordsFile(mulchId), "utf8")) as ShareRecord[];
  } catch {
    return [];
  }
}

async function writeShares(mulchId: string, records: ShareRecord[]): Promise<void> {
  await atomicWriteFile(recordsFile(mulchId), JSON.stringify(records, null, 1));
  state().live.delete(mulchId);
}

export function viewOf(record: ShareRecord): ShareView {
  const { ownerToken: _token, ...view } = record;
  void _token;
  return view;
}

/** This install's id; new shares are counted per install. */
async function installId(): Promise<string> {
  const settings = await readSettings();
  if (settings.installId) return settings.installId;
  const id = randomBytes(12).toString("hex");
  await writeSettings({ installId: id });
  return id;
}

async function client() {
  return shareClient({ install: await installId() });
}

/* ── files ─────────────────────────────────────────────────────── */

/** Files a node needs, as paths in the mulch folder (and in the share). */
export function filesOf(node: MulchNode): string[] {
  const files: string[] = [];
  if (node.assetId) files.push(`assets/${node.assetId}`, `assets/${node.assetId.split(".")[0]}.md`);
  if (node.docPath) files.push(node.docPath);
  return files;
}

/** Other files an HTML page refers to by a relative path next to it (images, styles). */
async function htmlCompanions(mulchId: string, docPath: string): Promise<string[]> {
  if (!docPath.endsWith(".html")) return [];
  const html = await fs.readFile(path.join(mulchDir(mulchId), docPath), "utf8").catch(() => "");
  const dir = path.posix.dirname(docPath);
  const out = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)=["']([^"'#?:]+)["']/g)) {
    const target = path.posix.normalize(path.posix.join(dir, match[1]));
    if (!target.startsWith("..") && target !== docPath && /^(artifacts|assets|docs)\//.test(target)) out.add(target);
  }
  return [...out];
}

async function upload(share: ShareRecord, mulchId: string, files: string[]): Promise<void> {
  const done = state().uploaded.get(share.id) ?? new Set<string>();
  state().uploaded.set(share.id, done);
  const api = await client();
  for (const file of files) {
    if (done.has(file)) continue;
    const bytes = await fs.readFile(path.join(mulchDir(mulchId), file)).catch(() => undefined);
    if (!bytes) continue;
    await api.uploadFile(share, file, new Uint8Array(bytes));
    done.add(file);
    // Decks and documents: their preview image, where the shared card looks for it.
    if (hasThumbnail(file) && file.startsWith("artifacts/")) {
      const result = await desktopRequest("thumbnail", { path: path.join(mulchDir(mulchId), file), size: 800 });
      if (result.ok && typeof result.value === "string") await api.uploadFile(share, thumbnailPath(file), new Uint8Array(Buffer.from(result.value, "base64")));
    }
  }
}

type TitleOf = (ref: NonNullable<MulchNode["ref"]>) => Promise<string | undefined>;
const resolvedTitle: TitleOf = async (ref) => (await resolveRef(ref).catch(() => undefined))?.title;

/**
 * The canvas as it is shared: a link card into the person's other mulches or
 * folders keeps only the linked item's title (taken now if the card has none);
 * where it lives and what it says stay private.
 */
export async function sharedMulch(mulch: Mulch, titleOf: TitleOf = resolvedTitle): Promise<Mulch> {
  const nodes = Object.fromEntries(await Promise.all(Object.entries(mulch.nodes).map(async ([id, node]) => [id, await sharedNode(node, titleOf)] as const)));
  return { ...mulch, nodes };
}

async function sharedNode(node: MulchNode, titleOf: TitleOf): Promise<MulchNode> {
  if (!node.ref) return node;
  const title = node.title ?? (await titleOf(node.ref));
  return { ...node, ...(title ? { title } : {}), ref: "sourceId" in node.ref ? { sourceId: "shared", path: "" } : { mulchId: "shared", itemId: "" } };
}

async function sharedOps(ops: MulchOp[]): Promise<MulchOp[]> {
  return Promise.all(ops.map(async (op) => (op.op === "addNode" ? { ...op, node: await sharedNode(op.node, resolvedTitle) } : op)));
}

/* ── sharing ───────────────────────────────────────────────────── */

/** Share a made file (deck, page, document). Sharing it again updates the same link. */
export async function shareArtifact(mulchId: string, nodeId: string): Promise<ShareView> {
  const mulch = await getMulch(mulchId);
  const node = mulch.nodes[nodeId];
  if (!node?.docPath) throw new ShareError(400, "Only a made file can be shared on its own.");
  const records = await readShares(mulchId);
  let record = records.find((r) => r.kind === "artifact" && r.docPath === node.docPath);
  if (!record) {
    const share = await (await client()).create({ kind: "artifact", title: node.title || path.basename(node.docPath), entry: node.docPath });
    record = { ...share, kind: "artifact", docPath: node.docPath, createdAt: Date.now() };
    await writeShares(mulchId, [...records, record]);
  }
  state().uploaded.delete(record.id);
  await upload(record, mulchId, [node.docPath, ...(await htmlCompanions(mulchId, node.docPath))]);
  log.info("share", "Shared a file", { mulchId, shareId: record.id });
  return viewOf(record);
}

/** Share the whole canvas, live. Sharing again turns live updates back on and refreshes everything. */
export async function shareMulch(mulchId: string): Promise<ShareView> {
  const mulch = await getMulch(mulchId);
  const records = await readShares(mulchId);
  let record = records.find((r) => r.kind === "mulch");
  const api = await client();
  if (!record) {
    const share = await api.create({ kind: "mulch", title: mulch.title });
    record = { ...share, kind: "mulch", createdAt: Date.now() };
  }
  record.live = true;
  await writeShares(mulchId, [...records.filter((r) => r.id !== record!.id), record]);
  state().uploaded.delete(record.id);
  const files = Object.values(mulch.nodes).flatMap(filesOf);
  for (const node of Object.values(mulch.nodes)) if (node.docPath) files.push(...(await htmlCompanions(mulchId, node.docPath)));
  await upload(record, mulchId, files);
  await api.uploadSnapshot(record, await sharedMulch(mulch));
  await api.setLive(record, true).catch(() => undefined);
  state().senders.delete(record.id);
  log.info("share", "Shared a canvas", { mulchId, shareId: record.id, files: files.length });
  return viewOf(record);
}

/** Stop live updates; the link keeps the last state. */
export async function stopLive(mulchId: string, shareId: string): Promise<ShareView[]> {
  const records = await readShares(mulchId);
  const record = records.find((r) => r.id === shareId);
  if (record) {
    await state().senders.get(shareId)?.flush();
    await (await client()).setLive(record, false).catch((error) => log.warn("share", "ending live failed", { mulchId, error }));
    record.live = false;
    state().senders.delete(shareId);
    await writeShares(mulchId, records);
  }
  return records.map(viewOf);
}

/** Delete the link and everything uploaded for it. */
export async function deleteShare(mulchId: string, shareId: string): Promise<ShareView[]> {
  const records = await readShares(mulchId);
  const record = records.find((r) => r.id === shareId);
  if (record) {
    await (await client()).remove(record).catch((error) => {
      if (!(error instanceof ShareError && error.status === 404)) throw error;
    });
    state().senders.delete(shareId);
    state().uploaded.delete(shareId);
  }
  const rest = records.filter((r) => r.id !== shareId);
  await writeShares(mulchId, rest);
  return rest.map(viewOf);
}

/* ── live ──────────────────────────────────────────────────────── */

async function liveShare(mulchId: string): Promise<ShareRecord | undefined> {
  const s = state();
  if (!s.live.has(mulchId)) s.live.set(mulchId, (await readShares(mulchId)).find((r) => r.kind === "mulch" && r.live) ?? null);
  return s.live.get(mulchId) ?? undefined;
}

/** Order of work per mulch, so files go before the batch that needs them. */
const chains = new Map<string, Promise<void>>();

async function forward(mulchId: string, batch: OpBatch): Promise<void> {
  const record = await liveShare(mulchId);
  if (!record) return;
  const s = state();
  const api = await client();
  let sender = s.senders.get(record.id);
  if (!sender) {
    // First change since the app started: the share may have missed some, so send the whole canvas first.
    if (!s.uploaded.has(record.id)) {
      const mulch = await getMulch(mulchId);
      await upload(record, mulchId, Object.values(mulch.nodes).flatMap(filesOf));
      await api.uploadSnapshot(record, await sharedMulch(mulch));
    }
    sender = api.liveSender(record);
    s.senders.set(record.id, sender);
  }
  const files = batch.ops.flatMap((op) => (op.op === "addNode" ? filesOf(op.node) : op.op === "updateNode" && (op.patch.assetId || op.patch.docPath) ? [op.patch.assetId ? `assets/${op.patch.assetId}` : "", op.patch.docPath ?? ""].filter(Boolean) : []));
  if (files.length) await upload(record, mulchId, files);
  sender.send({ ...batch, ops: await sharedOps(batch.ops) });
  if (sender.stopped) {
    log.warn("share", "live sharing stopped", { mulchId, shareId: record.id, error: sender.stopped.message });
    record.live = false;
    await writeShares(mulchId, (await readShares(mulchId)).map((r) => (r.id === record.id ? record : r)));
  }
}

onAfterApply((mulchId, batch) => {
  const previous = chains.get(mulchId) ?? Promise.resolve();
  const next = previous.then(() => forward(mulchId, batch)).catch((error) => log.warn("share", "live update failed", { mulchId, error }));
  chains.set(mulchId, next);
});

/* ── copies of shared canvases ─────────────────────────────────── */

/** Hosts a manifest may come from: the share origin (and the API's own, in development). */
export function allowedManifest(url: string): boolean {
  try {
    const parsed = new URL(url);
    const base = new URL(process.env.MLCH_SHARE_URL ?? "https://mlch.app");
    const hosts = new Set([base.host, `share.${base.host}`]);
    return (parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") && hosts.has(parsed.host) && /^\/api\/shares\/[A-Za-z0-9]+\/manifest$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Batches a live share holds beyond its stored snapshot (it folds them in
 * only now and then): read from the viewers' socket until it goes quiet.
 */
async function pendingBatches(shareUrl: string): Promise<OpBatch[]> {
  const url = new URL("live", shareUrl.endsWith("/") ? shareUrl : `${shareUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new Promise((resolve) => {
    const batches: OpBatch[] = [];
    let socket: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(batches);
    };
    const quiet = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(done, ms);
    };
    try {
      socket = new WebSocket(url);
    } catch {
      return resolve([]);
    }
    quiet(5000);
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type: string; batch?: OpBatch };
        if (message.type === "ops" && message.batch) batches.push(message.batch);
      } catch {
        // not ours
      }
      quiet(400);
    });
    socket.addEventListener("error", done);
    socket.addEventListener("close", done);
  });
}

/** "Open in mlch": a shared canvas (or file) becomes a new mulch of the person's own. */
export async function importShare(manifestUrl: string): Promise<string> {
  if (!allowedManifest(manifestUrl)) throw new ShareError(400, "Not an mlch share link.");
  const api = await client();
  const manifest: Manifest = await api.manifest(manifestUrl);
  const mulch = await createMulch(manifest.title || "Shared");
  const dir = mulchDir(mulch.id);
  for (const file of manifest.files) {
    if (!/^(assets|artifacts|docs)\/[^/]+$/.test(file.path) || file.path.includes("..")) continue;
    const response = await fetch(file.url);
    if (!response.ok) continue;
    await fs.mkdir(path.join(dir, path.dirname(file.path)), { recursive: true });
    await fs.writeFile(path.join(dir, file.path), Buffer.from(await response.arrayBuffer()));
  }
  const ops: MulchOp[] = [];
  if (manifest.kind === "mulch" && manifest.snapshotUrl) {
    const response = await fetch(manifest.snapshotUrl);
    if (!response.ok) throw new ShareError(response.status, "The shared canvas could not be read.");
    const pending = manifest.live ? await pendingBatches(manifest.url) : [];
    const shared = applyOps((await response.json()) as Mulch, pending.flatMap((batch) => batch.ops));
    for (const node of Object.values(shared.nodes)) {
      // Links to someone else's mulches and folders mean nothing here: keep them as plain cards.
      if (node.kind === "ref") ops.push({ op: "addNode", node: { ...node, kind: "idea", ref: undefined, text: node.title ?? "", title: undefined } });
      else ops.push({ op: "addNode", node });
    }
    for (const group of Object.values(shared.groups)) ops.push({ op: "addGroup", group });
    for (const edge of Object.values(shared.edges)) ops.push({ op: "addEdge", edge });
  } else if (manifest.entry) {
    const name = path.basename(manifest.entry);
    ops.push({ op: "addNode", node: { id: newClientId("n"), kind: "artifact", x: 0, y: 0, title: manifest.title, text: "", docPath: manifest.entry, fileName: name, origin: "user", createdAt: Date.now() } });
  }
  await applyToMulch(mulch.id, JSON.parse(JSON.stringify(ops)) as MulchOp[], "user");
  log.info("share", "Opened a shared canvas as a new mulch", { mulchId: mulch.id });
  return mulch.id;
}
