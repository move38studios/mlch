/**
 * Sharing from the app: a made file (a deck, a page) or the whole canvas as a
 * link on share.mlch.app. Server-only.
 *
 *   <mulch>/shares.json   this mulch's shares, with their owner tokens
 *
 * A shared canvas is live while sharing is on: every applied batch is sent
 * to the share (new files first), so people watching see it build up. What
 * goes: the items, their files, made things and write-ups. A link card goes
 * as what it links to (the item from the other mulch, or the note's text
 * from a linked folder) as an ordinary card, never as a link; what that item
 * links to in turn does not go.
 *
 * Shares go to the server chosen in Settings, Sharing (account.ts); each
 * share keeps the server it was made on.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { log } from "@/lib/log";
import { resolveRef } from "@/lib/links/links";
import { desktopRequest } from "@/lib/desktop/server";
import { hasThumbnail } from "@/lib/artifacts/thumbnails";
import { archiveMulch, atomicWriteFile, createMulch, applyToMulch, getMulch, isMulchId, mulchDir, onAfterApply, peekMulch } from "@/lib/mulch/store";
import { libraryDir } from "@/lib/desktop/server";
import { newClientId } from "@/lib/mulch/ids";
import { applyOps } from "@/lib/mulch/ops";
import type { Mulch, MulchNode, MulchOp, OpBatch } from "@/lib/mulch/types";
import { readSettings, writeSettings } from "@/lib/settings";
import { shareClient, ShareError, thumbnailPath, type LiveSender, type Manifest, type Share, type ShareKind } from "./client";
import { mlchServer, serverAddress, shareTarget } from "./account";

export interface ShareRecord extends Share {
  kind: ShareKind;
  /** The server it lives on (origin). Absent: mlch.app (shares made before there was a choice). */
  server?: string;
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

/** The server a share lives on. */
async function client(record?: ShareRecord) {
  return shareClient({ base: record?.server ?? mlchServer(), install: await installId() });
}

/** The server new shares go to, with its key or the person's session; refused with what to do when there is none. */
async function newShares(): Promise<{ api: Awaited<ReturnType<typeof client>>; server: string }> {
  const target = await shareTarget();
  if (target.mode === "off") throw new ShareError(409, "Sharing is off. Turn it on in Settings, Sharing.");
  if (!target.base) throw new ShareError(409, "Enter your server's address in Settings, Sharing.");
  if (target.mode === "mlch" && !target.auth) throw new ShareError(401, "Sign in to share: Settings, Sharing.");
  return { api: shareClient({ base: target.base, install: await installId(), auth: target.auth }), server: target.base };
}

/* ── files ─────────────────────────────────────────────────────── */

/** Files a node needs, as paths in the mulch folder (and in the share). */
export function filesOf(node: MulchNode): string[] {
  const files: string[] = [];
  if (node.assetId) files.push(`assets/${node.assetId}`, `assets/${node.assetId.split(".")[0]}.md`);
  if (node.docPath) files.push(node.docPath);
  if (node.poster) files.push(`assets/${node.poster}`);
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

/** A file for a share: a path in the mulch folder, or one from where a linked item lives. */
type ShareFile = string | { from: string; path: string };

async function upload(share: ShareRecord, mulchId: string, files: ShareFile[]): Promise<void> {
  const done = state().uploaded.get(share.id) ?? new Set<string>();
  state().uploaded.set(share.id, done);
  const api = await client(share);
  for (const entry of files) {
    const file = typeof entry === "string" ? entry : entry.path;
    const source = typeof entry === "string" ? path.join(mulchDir(mulchId), file) : entry.from;
    if (done.has(file)) continue;
    const bytes = await fs.readFile(source).catch(() => undefined);
    if (!bytes) continue;
    await api.uploadFile(share, file, new Uint8Array(bytes));
    done.add(file);
    // Decks and documents: their preview image, where the shared card looks for it.
    if (hasThumbnail(file) && file.startsWith("artifacts/")) {
      const result = await desktopRequest("thumbnail", { path: source, size: 800 });
      if (result.ok && typeof result.value === "string") await api.uploadFile(share, thumbnailPath(file), new Uint8Array(Buffer.from(result.value, "base64")));
    }
  }
}

/** What a link card goes as: the linked item's content as an ordinary card, and the files it needs. */
export interface Linked {
  node: MulchNode;
  files: Array<{ from: string; path: string }>;
}
export type LinkedOf = (card: MulchNode) => Promise<Linked | undefined>;

/**
 * The linked item itself in the card's place: an item from another mulch
 * (with its files), or a note from a linked folder as a write-up. A link
 * card's own target that is itself a link goes no further (one step).
 */
export const linkedContent: LinkedOf = async (card) => {
  const ref = card.ref!;
  const place = { id: card.id, x: card.x, y: card.y, ...(card.w ? { w: card.w } : {}), ...(card.h ? { h: card.h } : {}), ...(card.groupId ? { groupId: card.groupId } : {}) };
  if ("mulchId" in ref) {
    const target = (await peekMulch(ref.mulchId).catch(() => undefined))?.nodes[ref.itemId];
    if (!target || target.kind === "ref" || target.gen) return undefined;
    // The item's content in the card's place: not its link, group or size there.
    const content: Partial<MulchNode> = { ...target };
    delete content.ref;
    delete content.groupId;
    delete content.w;
    delete content.h;
    const dir = mulchDir(ref.mulchId);
    return { node: { ...content, ...place, ...keepSize(card, target.kind) } as MulchNode, files: filesOf(target).map((file) => ({ from: path.join(dir, file), path: file })) };
  }
  const resolved = await resolveRef(ref, true).catch(() => undefined);
  if (!resolved?.exists || !resolved.text) return undefined;
  return { node: { ...place, ...keepSize(card, "writeup"), kind: "writeup", title: resolved.title ?? card.title, text: plainNote(resolved.text), origin: card.origin, createdAt: card.createdAt }, files: [] };
};

/**
 * The canvas was laid out around the link card, so what it links to keeps the
 * card's size (its text clips; it opens in full). Pictures, players and files keep their own shape.
 */
function keepSize(card: MulchNode, kind: MulchNode["kind"]): Partial<MulchNode> {
  if (!card.h || kind === "image" || kind === "media" || kind === "artifact") return {};
  return { h: card.h, fixedH: true };
}

/** A note's text without HTML tags (notes from other tools carry some); the words stay. */
export function plainNote(text: string): string {
  return text
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * The canvas as it is shared: link cards replaced by what they link to.
 * Where a linked item lives never goes; a link that can't be read keeps only
 * its title.
 */
export async function sharedMulch(mulch: Mulch, linkedOf: LinkedOf = linkedContent): Promise<{ mulch: Mulch; files: Linked["files"] }> {
  const files: Linked["files"] = [];
  const nodes = Object.fromEntries(await Promise.all(Object.entries(mulch.nodes).map(async ([id, node]) => [id, await sharedNode(node, linkedOf, files)] as const)));
  // Comments are the person's own notes to the AI: never shared.
  const { comments: _comments, ...rest } = mulch;
  void _comments;
  return { mulch: { ...rest, nodes }, files };
}

async function sharedNode(node: MulchNode, linkedOf: LinkedOf, files: Linked["files"]): Promise<MulchNode> {
  if (!node.ref) return node;
  const linked = await linkedOf(node);
  if (linked) {
    files.push(...linked.files);
    return linked.node;
  }
  return { ...node, ref: "sourceId" in node.ref ? { sourceId: "shared", path: "" } : { mulchId: "shared", itemId: "" } };
}

async function sharedOps(ops: MulchOp[], files: Linked["files"]): Promise<MulchOp[]> {
  return Promise.all(
    ops.filter((op) => !op.op.endsWith("Comment")).map(async (op) => {
      if (op.op === "addNode") return { ...op, node: await sharedNode(op.node, linkedContent, files) };
      // A link card's target stays private in its changes too.
      if (op.op === "updateNode" && op.patch.ref) {
        const { ref: _ref, ...patch } = op.patch;
        void _ref;
        return { ...op, patch };
      }
      return op;
    }),
  );
}

/* ── sharing ───────────────────────────────────────────────────── */

/** A shared link's preview picture (Slack, iMessage, email), next to the shared files. */
const PREVIEW_FILE = "preview.png";

/** A made file's preview: a page's first screen, or a deck's or document's first page. Best effort. */
async function uploadPreview(record: ShareRecord, mulchId: string, docPath: string): Promise<void> {
  try {
    let png: Buffer | undefined;
    if (/\.(html|svg)$/.test(docPath)) {
      const result = await desktopRequest("render", { url: `/api/mulches/${mulchId}/${docPath}`, steps: 1 });
      const image = result.ok ? (result.value as { images?: string[] }).images?.[0] : undefined;
      if (image) png = Buffer.from(image, "base64");
    } else if (hasThumbnail(docPath)) {
      const result = await desktopRequest("thumbnail", { path: path.join(mulchDir(mulchId), docPath), size: 1200 });
      if (result.ok && typeof result.value === "string") png = Buffer.from(result.value, "base64");
    }
    if (png) await (await client(record)).uploadFile(record, PREVIEW_FILE, new Uint8Array(png));
  } catch (error) {
    log.warn("share", "preview not made", { mulchId, docPath, error });
  }
}

/** Share a made file (deck, page, document). Sharing it again updates the same link. */
export async function shareArtifact(mulchId: string, nodeId: string): Promise<ShareView> {
  const mulch = await getMulch(mulchId);
  const node = mulch.nodes[nodeId];
  if (!node?.docPath) throw new ShareError(400, "Only a made file can be shared on its own.");
  const records = await readShares(mulchId);
  let record = records.find((r) => r.kind === "artifact" && r.docPath === node.docPath);
  if (!record) {
    const { api, server } = await newShares();
    const share = await api.create({ kind: "artifact", title: node.title || path.basename(node.docPath), entry: node.docPath });
    record = { ...share, kind: "artifact", server, docPath: node.docPath, createdAt: Date.now() };
    await writeShares(mulchId, [...records, record]);
  }
  state().uploaded.delete(record.id);
  await upload(record, mulchId, [node.docPath, ...(await htmlCompanions(mulchId, node.docPath))]);
  await uploadPreview(record, mulchId, node.docPath);
  log.info("share", "Shared a file", { mulchId, shareId: record.id });
  return viewOf(record);
}

/** Share the whole canvas, live. Sharing again turns live updates back on and refreshes everything. */
export async function shareMulch(mulchId: string, preview?: Buffer): Promise<ShareView> {
  const mulch = await getMulch(mulchId);
  const records = await readShares(mulchId);
  let record = records.find((r) => r.kind === "mulch");
  if (!record) {
    const { api: fresh, server } = await newShares();
    const share = await fresh.create({ kind: "mulch", title: mulch.title });
    record = { ...share, kind: "mulch", server, createdAt: Date.now() };
  }
  const api = await client(record);
  record.live = true;
  await writeShares(mulchId, [...records.filter((r) => r.id !== record!.id), record]);
  state().uploaded.delete(record.id);
  const files = Object.values(mulch.nodes).flatMap(filesOf);
  for (const node of Object.values(mulch.nodes)) if (node.docPath) files.push(...(await htmlCompanions(mulchId, node.docPath)));
  const shared = await sharedMulch(mulch);
  await upload(record, mulchId, [...files, ...shared.files]);
  await api.uploadSnapshot(record, shared.mulch);
  if (preview?.subarray(1, 4).toString() === "PNG") await api.uploadFile(record, PREVIEW_FILE, new Uint8Array(preview)).catch((error) => log.warn("share", "preview not uploaded", { mulchId, error }));
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
    await (await client(record)).setLive(record, false).catch((error) => log.warn("share", "ending live failed", { mulchId, error }));
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
    await (await client(record)).remove(record).catch((error) => {
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
  // Sharing turned off in Settings: live links stop following (they keep the last state).
  if ((await shareTarget()).mode === "off") return;
  const s = state();
  const api = await client(record);
  let sender = s.senders.get(record.id);
  if (!sender) {
    // First change since the app started: the share may have missed some, so send the whole canvas first.
    if (!s.uploaded.has(record.id)) {
      const mulch = await getMulch(mulchId);
      const shared = await sharedMulch(mulch);
      await upload(record, mulchId, [...Object.values(mulch.nodes).flatMap(filesOf), ...shared.files]);
      await api.uploadSnapshot(record, shared.mulch);
    }
    sender = api.liveSender(record);
    s.senders.set(record.id, sender);
  }
  const files = batch.ops.flatMap((op) =>
    op.op === "addNode"
      ? filesOf(op.node)
      : op.op === "updateNode"
        ? [op.patch.assetId ? `assets/${op.patch.assetId}` : "", op.patch.poster ? `assets/${op.patch.poster}` : "", op.patch.docPath ?? ""].filter(Boolean)
        : [],
  );
  const linkedFiles: Linked["files"] = [];
  const ops = await sharedOps(batch.ops, linkedFiles);
  // Only comments changed: nothing to send.
  if (!ops.length) return;
  if (files.length || linkedFiles.length) await upload(record, mulchId, [...files, ...linkedFiles]);
  sender.send({ ...batch, ops });
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

/** Hosts a manifest may come from: mlch.app's share origin (and the API's own, in development), and the person's own server. */
export function allowedManifest(url: string, ownServer?: string): boolean {
  try {
    const parsed = new URL(url);
    const base = new URL(mlchServer());
    const hosts = new Set([base.host, `share.${base.host}`]);
    const own = ownServer ? serverAddress(ownServer) : undefined;
    if (own) hosts.add(new URL(own).host);
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

/** The same share: same server and share id (the link may differ in trailing details). */
function sameShare(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const [x, y] = [new URL(a), new URL(b)];
    return x.host === y.host && x.pathname.replace(/\/$/, "") === y.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

/** One of this library's own shares: the mulch it was made from (and, for a file, its card). */
export async function findOwnShare(manifestUrl: string): Promise<{ mulchId: string; nodeId?: string } | undefined> {
  const root = libraryDir();
  const ids = await fs.readdir(root).catch(() => [] as string[]);
  for (const mulchId of ids) {
    if (!isMulchId(mulchId)) continue;
    const record = (await readShares(mulchId)).find((r) => sameShare(r.manifestUrl, manifestUrl));
    if (!record) continue;
    const mulch = record.docPath ? await peekMulch(mulchId).catch(() => undefined) : undefined;
    const node = mulch && Object.values(mulch.nodes).find((n) => n.docPath === record.docPath);
    return { mulchId, ...(node ? { nodeId: node.id } : {}) };
  }
  return undefined;
}

/**
 * "Open in mlch": one's own share opens the mulch it came from (brought back
 * from the archive); someone else's becomes a new mulch of the person's own.
 */
export async function openShare(manifestUrl: string): Promise<{ mulchId: string; nodeId?: string }> {
  const own = await findOwnShare(manifestUrl);
  if (own) {
    await archiveMulch(own.mulchId, false);
    log.info("share", "Opened one's own share", { mulchId: own.mulchId });
    return own;
  }
  return { mulchId: await importShare(manifestUrl) };
}

/** A shared canvas (or file) becomes a new mulch of the person's own. */
export async function importShare(manifestUrl: string): Promise<string> {
  const settings = await readSettings();
  if (!allowedManifest(manifestUrl, settings.sharing === "own" ? settings.shareServer : undefined)) throw new ShareError(400, "Not an mlch share link.");
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
