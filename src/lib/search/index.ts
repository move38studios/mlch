/**
 * Search over mulches: one local SQLite index for the whole library. Server-only.
 *
 *   <library>/.index.sqlite, or in the app's own folder (MLCH_INDEX_DIR, one file per library) so a
 *   library in a synced folder (Dropbox, iCloud Drive) never syncs a database
 *     chunks       one row per passage: mulch, item, kind, page, text, vector
 *     chunks_fts   FTS5 over chunks (keyword search, bm25)
 *     items        per item: a signature of what was indexed, to skip unchanged items
 *
 * Every applied batch marks its items dirty; a debounced pass re-indexes
 * them (item text, full document/link text in passages with page numbers,
 * write-ups, artifact text, captions, media prompts) plus the transcript.
 * Embeddings are filled in by a background worker; search merges the
 * keyword ranking and the vector ranking (reciprocal rank fusion), so it
 * works before embeddings exist and when they are off.
 *
 * Linked folders (sources.ts) live in the same tables under the scope
 * `src:<sourceId>`, with the file's path as the item id.
 */

import { log } from "@/lib/log";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { libraryDir } from "@/lib/desktop/server";
import { readAssetText } from "@/lib/ingest/ingest";
import { getMulch, listMulches, MulchNotFoundError, mulchDir, onAfterApply, openMulch } from "@/lib/mulch/store";
import type { MulchNode, NodeKind } from "@/lib/mulch/types";
import { chunkText, htmlText } from "./chunk";
import { EMBED_DIMS, embed, embeddingsEnabled } from "./embed";

interface State {
  db?: DatabaseSync;
  dbPath?: string;
  dirty: Map<string, Set<string>>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  embedding: boolean;
  /** mulchId → cached vectors for search. */
  vectors: Map<string, { ids: number[]; data: Float32Array }>;
  indexed: Set<string>;
}

const globalState = globalThis as typeof globalThis & { __mlchSearch?: State };
function state(): State {
  return (globalState.__mlchSearch ??= { dirty: new Map(), timers: new Map(), embedding: false, vectors: new Map(), indexed: new Set() });
}

/** The index for a library: in MLCH_INDEX_DIR when the app sets one, else in the library. */
export function indexFile(library: string): string {
  const dir = process.env.MLCH_INDEX_DIR;
  if (!dir) return path.join(library, ".index.sqlite");
  const key = createHash("sha256").update(path.resolve(library)).digest("hex").slice(0, 16);
  return path.join(dir, `library-${key}.sqlite`);
}

function db(): DatabaseSync {
  const s = state();
  const file = indexFile(libraryDir());
  if (s.db && s.dbPath === file) return s.db;
  // Loaded at run time: the bundler does not know node:sqlite.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      mulch_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT,
      page INTEGER,
      offset INTEGER,
      text TEXT NOT NULL,
      vector BLOB
    );
    CREATE INDEX IF NOT EXISTS chunks_item ON chunks(mulch_id, node_id);
    CREATE INDEX IF NOT EXISTS chunks_pending ON chunks(vector) WHERE vector IS NULL;
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, title, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text, title) VALUES (new.id, new.text, new.title);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text, title) VALUES ('delete', old.id, old.text, old.title);
    END;
    CREATE TABLE IF NOT EXISTS items (
      mulch_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      signature TEXT NOT NULL,
      PRIMARY KEY (mulch_id, node_id)
    );
  `);
  s.db = database;
  s.dbPath = file;
  s.vectors.clear();
  s.indexed.clear();
  return database;
}

/* ── indexing ──────────────────────────────────────────────────── */

const TRANSCRIPT = "transcript";

/** Index scope prefix for linked folders. */
export const SOURCE_SCOPE = "src:";

export interface Row {
  kind: string;
  source: string;
  title?: string;
  page?: number;
  offset?: number;
  text: string;
}

function signature(node: MulchNode): string {
  return createHash("sha1").update(JSON.stringify([node.kind, node.title, node.text, node.assetId, node.docPath, node.url, node.fileName, node.gen?.status])).digest("hex");
}

async function rowsFor(mulchId: string, node: MulchNode): Promise<Row[]> {
  const title = [node.title, node.fileName].filter(Boolean).join(" · ") || undefined;
  const rows: Row[] = [];
  const head = [node.title, node.text, node.url].filter(Boolean).join("\n");
  if (head.trim()) rows.push({ kind: node.kind, source: "item", title, text: head.slice(0, 4000) });
  // Full text of documents and links lives beside their file.
  if ((node.kind === "doc" || node.kind === "link") && node.assetId) {
    const full = await readAssetText(mulchId, node.assetId);
    if (full) for (const passage of chunkText(full)) rows.push({ kind: node.kind, source: "full", title, page: passage.page, offset: passage.offset, text: passage.text });
  }
  if ((node.kind === "writeup" || node.kind === "artifact") && node.docPath && /\.(md|html|svg|csv|json|txt)$/.test(node.docPath)) {
    try {
      const raw = await fs.readFile(path.join(mulchDir(mulchId), node.docPath), "utf8");
      const text = node.docPath.endsWith(".html") || node.docPath.endsWith(".svg") ? htmlText(raw) : raw;
      for (const passage of chunkText(text)) rows.push({ kind: node.kind, source: "full", title, offset: passage.offset, text: passage.text });
    } catch {
      // file gone
    }
  }
  return rows;
}

/** Replace one item's rows. `mulchId` is a mulch id or a source scope. */
export function replaceRows(mulchId: string, nodeId: string, rows: Row[], sig: string | undefined): void {
  const database = db();
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM chunks WHERE mulch_id = ? AND node_id = ?").run(mulchId, nodeId);
    const insert = database.prepare("INSERT INTO chunks (mulch_id, node_id, kind, source, title, page, offset, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const row of rows) insert.run(mulchId, nodeId, row.kind, row.source, row.title ?? null, row.page ?? null, row.offset ?? null, row.text);
    if (sig) database.prepare("INSERT OR REPLACE INTO items (mulch_id, node_id, signature) VALUES (?, ?, ?)").run(mulchId, nodeId, sig);
    else database.prepare("DELETE FROM items WHERE mulch_id = ? AND node_id = ?").run(mulchId, nodeId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  state().vectors.delete(mulchId);
}

/** Bring the index for these items (or the whole mulch) up to date. */
export async function indexMulch(mulchId: string, nodeIds?: Iterable<string>): Promise<void> {
  const mulch = await getMulch(mulchId);
  const database = db();
  const known = new Map(
    (database.prepare("SELECT node_id, signature FROM items WHERE mulch_id = ?").all(mulchId) as Array<{ node_id: string; signature: string }>).map((r) => [r.node_id, r.signature]),
  );
  const targets = nodeIds ? new Set(nodeIds) : new Set([...Object.keys(mulch.nodes), ...known.keys()]);
  targets.delete(TRANSCRIPT);
  for (const nodeId of targets) {
    const node = mulch.nodes[nodeId];
    if (!node) {
      if (known.has(nodeId)) replaceRows(mulchId, nodeId, [], undefined);
      continue;
    }
    const sig = signature(node);
    if (known.get(nodeId) === sig) continue;
    replaceRows(mulchId, nodeId, await rowsFor(mulchId, node), sig);
  }
  // The transcript, in passages of a few segments.
  const transcript = (await openMulch(mulchId)).transcript;
  const transcriptSig = createHash("sha1").update(String(transcript.length) + (transcript.at(-1)?.id ?? "")).digest("hex");
  if (known.get(TRANSCRIPT) !== transcriptSig) {
    const rows: Row[] = [];
    for (let i = 0; i < transcript.length; i += 4) {
      const group = transcript.slice(i, i + 4);
      rows.push({ kind: "transcript", source: "transcript", title: new Date(group[0].at).toISOString(), offset: i, text: group.map((s) => s.text).join(" ") });
    }
    replaceRows(mulchId, TRANSCRIPT, rows, transcriptSig);
  }
  state().indexed.add(mulchId);
  void embedPending();
}

async function ensureIndexed(mulchId: string): Promise<void> {
  if (!state().indexed.has(mulchId)) await indexMulch(mulchId);
}

/** Item id → signature for what is indexed under a mulch or source scope. */
export function knownSignatures(scope: string): Map<string, string> {
  return new Map((db().prepare("SELECT node_id, signature FROM items WHERE mulch_id = ?").all(scope) as Array<{ node_id: string; signature: string }>).map((r) => [r.node_id, r.signature]));
}

/** Remove a mulch (moved to the trash) or a source scope from the index. */
export function dropMulch(mulchId: string): void {
  db().prepare("DELETE FROM chunks WHERE mulch_id = ?").run(mulchId);
  db().prepare("DELETE FROM items WHERE mulch_id = ?").run(mulchId);
  state().vectors.delete(mulchId);
  state().indexed.delete(mulchId);
}

/** Embed passages that have no vector yet, in the background. */
export async function embedPending(): Promise<void> {
  const s = state();
  if (s.embedding || !embeddingsEnabled()) return;
  s.embedding = true;
  try {
    const database = db();
    const select: StatementSync = database.prepare("SELECT id, mulch_id, title, text FROM chunks WHERE vector IS NULL LIMIT 12");
    const update = database.prepare("UPDATE chunks SET vector = ? WHERE id = ?");
    for (;;) {
      const batch = select.all() as Array<{ id: number; mulch_id: string; title: string | null; text: string }>;
      if (!batch.length) break;
      const vectors = await embed(batch.map((row) => (row.title ? `${row.title}: ${row.text}` : row.text)), "passage");
      if (!vectors) break;
      database.exec("BEGIN");
      batch.forEach((row, i) => update.run(Buffer.from(vectors[i].buffer, vectors[i].byteOffset, vectors[i].byteLength), row.id));
      database.exec("COMMIT");
      for (const mulchId of new Set(batch.map((row) => row.mulch_id))) s.vectors.delete(mulchId);
    }
  } catch (error) {
    log.error("search", "embedding failed", { error });
  } finally {
    s.embedding = false;
  }
}

/* ── hooks ─────────────────────────────────────────────────────── */

onAfterApply((mulchId, batch) => {
  const s = state();
  const dirty = s.dirty.get(mulchId) ?? new Set<string>();
  for (const op of batch.ops) {
    if (op.op === "addNode") dirty.add(op.node.id);
    else if (op.op === "updateNode" || op.op === "removeNode") dirty.add(op.id);
  }
  // A transcript change has no op; recheck it with any batch.
  dirty.add(TRANSCRIPT);
  s.dirty.set(mulchId, dirty);
  if (s.timers.has(mulchId)) return;
  s.timers.set(
    mulchId,
    setTimeout(() => {
      s.timers.delete(mulchId);
      const ids = s.dirty.get(mulchId) ?? new Set();
      s.dirty.delete(mulchId);
      indexMulch(mulchId, ids).catch((error) => {
        // The mulch was moved to the trash meanwhile.
        if (error instanceof MulchNotFoundError) return;
        log.error("search", "index failed", { mulchId, error });
      });
    }, 1500),
  );
});

/* ── searching ─────────────────────────────────────────────────── */

export interface SearchHit {
  /** The mulch; empty for a hit in a linked folder (then `sourceId` and `path`). */
  mulchId: string;
  /** The item; for a linked folder, the file's path in it. */
  nodeId: string;
  sourceId?: string;
  path?: string;
  kind: NodeKind | "transcript" | "file";
  title?: string;
  /** The passage, trimmed around the match. */
  snippet: string;
  page?: number;
  offset?: number;
  score: number;
}

function ftsQuery(query: string): string | undefined {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1)
    .slice(0, 12);
  if (!words.length) return undefined;
  return words.map((w) => `"${w}"*`).join(" OR ");
}

function snippetAround(text: string, query: string, size = 320): string {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const lower = text.toLowerCase();
  const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - size / 3);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + size).trim()}${start + size < text.length ? "…" : ""}`;
}

function vectorsFor(mulchIds: string[]): Array<{ ids: number[]; data: Float32Array }> {
  const s = state();
  return mulchIds.map((mulchId) => {
    const cached = s.vectors.get(mulchId);
    if (cached) return cached;
    const rows = db().prepare("SELECT id, vector FROM chunks WHERE mulch_id = ? AND vector IS NOT NULL").all(mulchId) as Array<{ id: number; vector: Uint8Array }>;
    const data = new Float32Array(rows.length * EMBED_DIMS);
    rows.forEach((row, i) => data.set(new Float32Array(row.vector.buffer, row.vector.byteOffset, EMBED_DIMS), i * EMBED_DIMS));
    const value = { ids: rows.map((r) => r.id), data };
    s.vectors.set(mulchId, value);
    return value;
  });
}

export interface SearchOptions {
  /** Mulches to search; all mulches when absent. */
  mulchIds?: string[];
  /** Linked folders to search too (source ids). */
  sources?: string[];
  kinds?: string[];
  limit?: number;
}

export async function search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  const mulchIdsOnly = options.mulchIds ?? (await listMulches()).map((n) => n.id);
  for (const id of mulchIdsOnly) await ensureIndexed(id);
  // Scopes: mulches and linked folders share the tables.
  const mulchIds = [...mulchIdsOnly, ...(options.sources ?? []).map((id) => `${SOURCE_SCOPE}${id}`)];
  const database = db();
  const limit = options.limit ?? 12;
  const placeholders = mulchIds.map(() => "?").join(",") || "''";
  const kindFilter = options.kinds?.length ? ` AND c.kind IN (${options.kinds.map(() => "?").join(",")})` : "";
  const ranks = new Map<number, number>();

  const fts = ftsQuery(query);
  if (fts) {
    const rows = database
      .prepare(`SELECT c.id FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ? AND c.mulch_id IN (${placeholders})${kindFilter} ORDER BY bm25(chunks_fts, 1.0, 2.0) LIMIT 60`)
      .all(fts, ...mulchIds, ...(options.kinds ?? [])) as Array<{ id: number }>;
    rows.forEach((row, rank) => ranks.set(row.id, (ranks.get(row.id) ?? 0) + 1 / (60 + rank)));
  }

  // Searching never waits long for the model: keyword results stand on their own.
  const queryVector = (await embed([query], "query", 8000))?.[0];
  if (queryVector) {
    const scored: Array<{ id: number; score: number }> = [];
    for (const { ids, data } of vectorsFor(mulchIds)) {
      for (let i = 0; i < ids.length; i++) {
        let dot = 0;
        const base = i * EMBED_DIMS;
        for (let j = 0; j < EMBED_DIMS; j++) dot += data[base + j] * queryVector[j];
        scored.push({ id: ids[i], score: dot });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    let allowed: Set<number> | undefined;
    if (options.kinds?.length) {
      const top = scored.slice(0, 400).map((s) => s.id);
      allowed = new Set(
        (database.prepare(`SELECT id FROM chunks WHERE id IN (${top.map(() => "?").join(",") || "''"}) AND kind IN (${options.kinds.map(() => "?").join(",")})`).all(...top, ...options.kinds) as Array<{ id: number }>).map((r) => r.id),
      );
    }
    scored
      .filter((s) => !allowed || allowed.has(s.id))
      .slice(0, 60)
      .forEach((row, rank) => ranks.set(row.id, (ranks.get(row.id) ?? 0) + 1 / (60 + rank)));
  }

  const ordered = [...ranks.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit * 3);
  if (!ordered.length) return [];
  const rows = database
    .prepare(`SELECT id, mulch_id, node_id, kind, title, page, offset, text FROM chunks WHERE id IN (${ordered.map(() => "?").join(",")})`)
    .all(...ordered.map(([id]) => id)) as Array<{ id: number; mulch_id: string; node_id: string; kind: string; title: string | null; page: number | null; offset: number | null; text: string }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const hits: SearchHit[] = [];
  const seen = new Map<string, number>();
  for (const [id, score] of ordered) {
    const row = byId.get(id);
    if (!row) continue;
    // At most two passages per item, so one long book does not crowd out the rest.
    const key = `${row.mulch_id}/${row.node_id}`;
    if ((seen.get(key) ?? 0) >= 2) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    const sourceId = row.mulch_id.startsWith(SOURCE_SCOPE) ? row.mulch_id.slice(SOURCE_SCOPE.length) : undefined;
    hits.push({
      mulchId: sourceId ? "" : row.mulch_id,
      nodeId: row.node_id,
      ...(sourceId ? { sourceId, path: row.node_id } : {}),
      kind: row.kind as SearchHit["kind"],
      ...(row.title ? { title: row.title } : {}),
      snippet: snippetAround(row.text, query),
      ...(row.page !== null ? { page: row.page } : {}),
      ...(row.offset !== null ? { offset: row.offset } : {}),
      score: Math.round(score * 10000) / 10000,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Text of an item's source around a page or offset (for reading after a hit). */
export async function readAround(mulchId: string, nodeId: string, at: { page?: number; offset?: number }, size = 6000): Promise<string | undefined> {
  const mulch = await getMulch(mulchId);
  const node = mulch.nodes[nodeId];
  if (!node) return undefined;
  let full: string | undefined;
  if (node.assetId && (node.kind === "doc" || node.kind === "link")) full = await readAssetText(mulchId, node.assetId);
  else if (node.docPath) full = await fs.readFile(path.join(mulchDir(mulchId), node.docPath), "utf8").catch(() => undefined);
  full ??= [node.title, node.text].filter(Boolean).join("\n\n");
  return sliceAround(full, at, size);
}

/** A window of a long text around a page marker or a character offset. */
export function sliceAround(full: string, at: { page?: number; offset?: number }, size = 6000): string {
  let start = at.offset ?? 0;
  if (at.page !== undefined) {
    const marker = full.indexOf(`--- page ${at.page} ---`);
    if (marker >= 0) start = marker;
  }
  start = Math.max(0, start - 500);
  return `${start > 0 ? `(from character ${start} of ${full.length})\n` : ""}${full.slice(start, start + size)}${start + size < full.length ? "\n…(more; read on with a larger offset)" : ""}`;
}
