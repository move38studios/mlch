/**
 * Search over napkins: one local SQLite index for the whole library. Server-only.
 *
 *   <library>/.index.sqlite
 *     chunks       one row per passage: napkin, item, kind, page, text, vector
 *     chunks_fts   FTS5 over chunks (keyword search, bm25)
 *     items        per item: a signature of what was indexed, to skip unchanged items
 *
 * Every applied batch marks its items dirty; a debounced pass re-indexes
 * them (item text, full document/link text in passages with page numbers,
 * write-ups, artifact text, captions, media prompts) plus the transcript.
 * Embeddings are filled in by a background worker; search merges the
 * keyword ranking and the vector ranking (reciprocal rank fusion), so it
 * works before embeddings exist and when they are off.
 */

import { log } from "@/lib/log";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { libraryDir } from "@/lib/desktop/server";
import { readAssetText } from "@/lib/ingest/ingest";
import { getNapkin, listNapkins, NapkinNotFoundError, napkinDir, onAfterApply, openNapkin } from "@/lib/napkin/store";
import type { NapkinNode, NodeKind } from "@/lib/napkin/types";
import { chunkText, htmlText } from "./chunk";
import { EMBED_DIMS, embed, embeddingsEnabled } from "./embed";

interface State {
  db?: DatabaseSync;
  dbPath?: string;
  dirty: Map<string, Set<string>>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  embedding: boolean;
  /** napkinId → cached vectors for search. */
  vectors: Map<string, { ids: number[]; data: Float32Array }>;
  indexed: Set<string>;
}

const globalState = globalThis as typeof globalThis & { __npknSearch?: State };
function state(): State {
  return (globalState.__npknSearch ??= { dirty: new Map(), timers: new Map(), embedding: false, vectors: new Map(), indexed: new Set() });
}

function db(): DatabaseSync {
  const s = state();
  const file = path.join(libraryDir(), ".index.sqlite");
  if (s.db && s.dbPath === file) return s.db;
  // Loaded at run time: the bundler does not know node:sqlite.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      napkin_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT,
      page INTEGER,
      offset INTEGER,
      text TEXT NOT NULL,
      vector BLOB
    );
    CREATE INDEX IF NOT EXISTS chunks_item ON chunks(napkin_id, node_id);
    CREATE INDEX IF NOT EXISTS chunks_pending ON chunks(vector) WHERE vector IS NULL;
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, title, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text, title) VALUES (new.id, new.text, new.title);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text, title) VALUES ('delete', old.id, old.text, old.title);
    END;
    CREATE TABLE IF NOT EXISTS items (
      napkin_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      signature TEXT NOT NULL,
      PRIMARY KEY (napkin_id, node_id)
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

interface Row {
  kind: string;
  source: string;
  title?: string;
  page?: number;
  offset?: number;
  text: string;
}

function signature(node: NapkinNode): string {
  return createHash("sha1").update(JSON.stringify([node.kind, node.title, node.text, node.assetId, node.docPath, node.url, node.fileName, node.gen?.status])).digest("hex");
}

async function rowsFor(napkinId: string, node: NapkinNode): Promise<Row[]> {
  const title = [node.title, node.fileName].filter(Boolean).join(" · ") || undefined;
  const rows: Row[] = [];
  const head = [node.title, node.text, node.url].filter(Boolean).join("\n");
  if (head.trim()) rows.push({ kind: node.kind, source: "item", title, text: head.slice(0, 4000) });
  // Full text of documents and links lives beside their file.
  if ((node.kind === "doc" || node.kind === "link") && node.assetId) {
    const full = await readAssetText(napkinId, node.assetId);
    if (full) for (const passage of chunkText(full)) rows.push({ kind: node.kind, source: "full", title, page: passage.page, offset: passage.offset, text: passage.text });
  }
  if ((node.kind === "writeup" || node.kind === "artifact") && node.docPath && /\.(md|html|svg|csv|json|txt)$/.test(node.docPath)) {
    try {
      const raw = await fs.readFile(path.join(napkinDir(napkinId), node.docPath), "utf8");
      const text = node.docPath.endsWith(".html") || node.docPath.endsWith(".svg") ? htmlText(raw) : raw;
      for (const passage of chunkText(text)) rows.push({ kind: node.kind, source: "full", title, offset: passage.offset, text: passage.text });
    } catch {
      // file gone
    }
  }
  return rows;
}

function replaceRows(napkinId: string, nodeId: string, rows: Row[], sig: string | undefined): void {
  const database = db();
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM chunks WHERE napkin_id = ? AND node_id = ?").run(napkinId, nodeId);
    const insert = database.prepare("INSERT INTO chunks (napkin_id, node_id, kind, source, title, page, offset, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const row of rows) insert.run(napkinId, nodeId, row.kind, row.source, row.title ?? null, row.page ?? null, row.offset ?? null, row.text);
    if (sig) database.prepare("INSERT OR REPLACE INTO items (napkin_id, node_id, signature) VALUES (?, ?, ?)").run(napkinId, nodeId, sig);
    else database.prepare("DELETE FROM items WHERE napkin_id = ? AND node_id = ?").run(napkinId, nodeId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  state().vectors.delete(napkinId);
}

/** Bring the index for these items (or the whole napkin) up to date. */
export async function indexNapkin(napkinId: string, nodeIds?: Iterable<string>): Promise<void> {
  const napkin = await getNapkin(napkinId);
  const database = db();
  const known = new Map(
    (database.prepare("SELECT node_id, signature FROM items WHERE napkin_id = ?").all(napkinId) as Array<{ node_id: string; signature: string }>).map((r) => [r.node_id, r.signature]),
  );
  const targets = nodeIds ? new Set(nodeIds) : new Set([...Object.keys(napkin.nodes), ...known.keys()]);
  targets.delete(TRANSCRIPT);
  for (const nodeId of targets) {
    const node = napkin.nodes[nodeId];
    if (!node) {
      if (known.has(nodeId)) replaceRows(napkinId, nodeId, [], undefined);
      continue;
    }
    const sig = signature(node);
    if (known.get(nodeId) === sig) continue;
    replaceRows(napkinId, nodeId, await rowsFor(napkinId, node), sig);
  }
  // The transcript, in passages of a few segments.
  const transcript = (await openNapkin(napkinId)).transcript;
  const transcriptSig = createHash("sha1").update(String(transcript.length) + (transcript.at(-1)?.id ?? "")).digest("hex");
  if (known.get(TRANSCRIPT) !== transcriptSig) {
    const rows: Row[] = [];
    for (let i = 0; i < transcript.length; i += 4) {
      const group = transcript.slice(i, i + 4);
      rows.push({ kind: "transcript", source: "transcript", title: new Date(group[0].at).toISOString(), offset: i, text: group.map((s) => s.text).join(" ") });
    }
    replaceRows(napkinId, TRANSCRIPT, rows, transcriptSig);
  }
  state().indexed.add(napkinId);
  void embedPending();
}

async function ensureIndexed(napkinId: string): Promise<void> {
  if (!state().indexed.has(napkinId)) await indexNapkin(napkinId);
}

/** Remove a napkin from the index (it was moved to the trash). */
export function dropNapkin(napkinId: string): void {
  db().prepare("DELETE FROM chunks WHERE napkin_id = ?").run(napkinId);
  db().prepare("DELETE FROM items WHERE napkin_id = ?").run(napkinId);
  state().vectors.delete(napkinId);
  state().indexed.delete(napkinId);
}

/** Embed passages that have no vector yet, in the background. */
async function embedPending(): Promise<void> {
  const s = state();
  if (s.embedding || !embeddingsEnabled()) return;
  s.embedding = true;
  try {
    const database = db();
    const select: StatementSync = database.prepare("SELECT id, napkin_id, title, text FROM chunks WHERE vector IS NULL LIMIT 12");
    const update = database.prepare("UPDATE chunks SET vector = ? WHERE id = ?");
    for (;;) {
      const batch = select.all() as Array<{ id: number; napkin_id: string; title: string | null; text: string }>;
      if (!batch.length) break;
      const vectors = await embed(batch.map((row) => (row.title ? `${row.title}: ${row.text}` : row.text)), "passage");
      if (!vectors) break;
      database.exec("BEGIN");
      batch.forEach((row, i) => update.run(Buffer.from(vectors[i].buffer, vectors[i].byteOffset, vectors[i].byteLength), row.id));
      database.exec("COMMIT");
      for (const napkinId of new Set(batch.map((row) => row.napkin_id))) s.vectors.delete(napkinId);
    }
  } catch (error) {
    log.error("search", "embedding failed", { error });
  } finally {
    s.embedding = false;
  }
}

/* ── hooks ─────────────────────────────────────────────────────── */

onAfterApply((napkinId, batch) => {
  const s = state();
  const dirty = s.dirty.get(napkinId) ?? new Set<string>();
  for (const op of batch.ops) {
    if (op.op === "addNode") dirty.add(op.node.id);
    else if (op.op === "updateNode" || op.op === "removeNode") dirty.add(op.id);
  }
  // A transcript change has no op; recheck it with any batch.
  dirty.add(TRANSCRIPT);
  s.dirty.set(napkinId, dirty);
  if (s.timers.has(napkinId)) return;
  s.timers.set(
    napkinId,
    setTimeout(() => {
      s.timers.delete(napkinId);
      const ids = s.dirty.get(napkinId) ?? new Set();
      s.dirty.delete(napkinId);
      indexNapkin(napkinId, ids).catch((error) => {
        // The napkin was moved to the trash meanwhile.
        if (error instanceof NapkinNotFoundError) return;
        log.error("search", "index failed", { napkinId, error });
      });
    }, 1500),
  );
});

/* ── searching ─────────────────────────────────────────────────── */

export interface SearchHit {
  napkinId: string;
  nodeId: string;
  kind: NodeKind | "transcript";
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

function vectorsFor(napkinIds: string[]): Array<{ ids: number[]; data: Float32Array }> {
  const s = state();
  return napkinIds.map((napkinId) => {
    const cached = s.vectors.get(napkinId);
    if (cached) return cached;
    const rows = db().prepare("SELECT id, vector FROM chunks WHERE napkin_id = ? AND vector IS NOT NULL").all(napkinId) as Array<{ id: number; vector: Uint8Array }>;
    const data = new Float32Array(rows.length * EMBED_DIMS);
    rows.forEach((row, i) => data.set(new Float32Array(row.vector.buffer, row.vector.byteOffset, EMBED_DIMS), i * EMBED_DIMS));
    const value = { ids: rows.map((r) => r.id), data };
    s.vectors.set(napkinId, value);
    return value;
  });
}

export interface SearchOptions {
  /** Napkins to search; all napkins when absent. */
  napkinIds?: string[];
  kinds?: string[];
  limit?: number;
}

export async function search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  const napkinIds = options.napkinIds ?? (await listNapkins()).map((n) => n.id);
  for (const id of napkinIds) await ensureIndexed(id);
  const database = db();
  const limit = options.limit ?? 12;
  const placeholders = napkinIds.map(() => "?").join(",") || "''";
  const kindFilter = options.kinds?.length ? ` AND c.kind IN (${options.kinds.map(() => "?").join(",")})` : "";
  const ranks = new Map<number, number>();

  const fts = ftsQuery(query);
  if (fts) {
    const rows = database
      .prepare(`SELECT c.id FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ? AND c.napkin_id IN (${placeholders})${kindFilter} ORDER BY bm25(chunks_fts, 1.0, 2.0) LIMIT 60`)
      .all(fts, ...napkinIds, ...(options.kinds ?? [])) as Array<{ id: number }>;
    rows.forEach((row, rank) => ranks.set(row.id, (ranks.get(row.id) ?? 0) + 1 / (60 + rank)));
  }

  // Searching never waits long for the model: keyword results stand on their own.
  const queryVector = (await embed([query], "query", 8000))?.[0];
  if (queryVector) {
    const scored: Array<{ id: number; score: number }> = [];
    for (const { ids, data } of vectorsFor(napkinIds)) {
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
    .prepare(`SELECT id, napkin_id, node_id, kind, title, page, offset, text FROM chunks WHERE id IN (${ordered.map(() => "?").join(",")})`)
    .all(...ordered.map(([id]) => id)) as Array<{ id: number; napkin_id: string; node_id: string; kind: string; title: string | null; page: number | null; offset: number | null; text: string }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const hits: SearchHit[] = [];
  const seen = new Map<string, number>();
  for (const [id, score] of ordered) {
    const row = byId.get(id);
    if (!row) continue;
    // At most two passages per item, so one long book does not crowd out the rest.
    const key = `${row.napkin_id}/${row.node_id}`;
    if ((seen.get(key) ?? 0) >= 2) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    hits.push({
      napkinId: row.napkin_id,
      nodeId: row.node_id,
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
export async function readAround(napkinId: string, nodeId: string, at: { page?: number; offset?: number }, size = 6000): Promise<string | undefined> {
  const napkin = await getNapkin(napkinId);
  const node = napkin.nodes[nodeId];
  if (!node) return undefined;
  let full: string | undefined;
  if (node.assetId && (node.kind === "doc" || node.kind === "link")) full = await readAssetText(napkinId, node.assetId);
  else if (node.docPath) full = await fs.readFile(path.join(napkinDir(napkinId), node.docPath), "utf8").catch(() => undefined);
  full ??= [node.title, node.text].filter(Boolean).join("\n\n");
  let start = at.offset ?? 0;
  if (at.page !== undefined) {
    const marker = full.indexOf(`--- page ${at.page} ---`);
    if (marker >= 0) start = marker;
  }
  start = Math.max(0, start - 500);
  return `${start > 0 ? `(from character ${start} of ${full.length})\n` : ""}${full.slice(start, start + size)}${start + size < full.length ? "\n…(more; read on with a larger offset)" : ""}`;
}
