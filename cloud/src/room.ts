/**
 * One shared item (a canvas or an artifact): who may change it, which files
 * it holds, and, for a canvas, its live state.
 *
 * Live canvases: the owner's app sends op batches; the room numbers them
 * (seq), keeps the ones since the last snapshot, and passes them to every
 * viewer over a hibernating WebSocket. Every so often it folds them into the
 * snapshot in R2 with the app's own `applyOps`, so the snapshot plus the
 * batches after its seq is always the current canvas. Today there is one
 * writer (the owner); the room already assigns the order, so more writers
 * (collaboration) can join later without changing what viewers receive.
 *
 * Viewer protocol (server → viewer, JSON text frames):
 *   { type: "hello", kind, title, live, seq, snapshotSeq }  then every batch after snapshotSeq as
 *   { type: "ops", seq, batch }                              in order, then live ones as they come
 *   { type: "snapshot", seq }                                the owner replaced the whole canvas: refetch
 *   { type: "live", live }                                   sharing turned on or off
 *   { type: "deleted" }                                      the share is gone
 */

import { DurableObject } from "cloudflare:workers";
import { applyOps } from "../../src/lib/mulch/ops";
import type { Mulch, OpBatch } from "../../src/lib/mulch/types";
import { LIMITS, type Env, type ShareKind } from "./env";

export type Result<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

export interface ShareInfo {
  id: string;
  kind: ShareKind;
  title: string;
  entry?: string;
  live: boolean;
  seq: number;
  snapshotSeq: number;
  hasSnapshot: boolean;
  createdAt: number;
  updatedAt: number;
  files: Array<{ path: string; size: number }>;
}

export const r2Key = {
  prefix: (id: string) => `shares/${id}/`,
  file: (id: string, path: string) => `shares/${id}/files/${path}`,
  snapshot: (id: string) => `shares/${id}/snapshot.json`,
};

/** Fold batches into the snapshot once this many are waiting, or this long after the last one. */
const COMPACT_AFTER_BATCHES = 200;
const COMPACT_DELAY_MS = 20_000;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

const fail = (status: number, error: string) => ({ ok: false as const, status, error });

export class ShareRoom extends DurableObject<Env> {
  private sql: SqlStorage;
  /** Snapshot writes (owner uploads and compaction) one at a time, so an older one never lands last. */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.schema();
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private schema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS batches (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
    `);
  }

  private get(key: string): string | undefined {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", key).toArray()[0];
    return row?.v;
  }

  private set(key: string, value: string | number | boolean): void {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, String(value));
  }

  private num(key: string): number {
    return Number(this.get(key) ?? 0);
  }

  private touch(): void {
    this.set("updatedAt", Date.now());
  }

  private async owner(token: string | undefined): Promise<Result<object>> {
    const hash = this.get("tokenHash");
    if (!hash) return fail(404, "No such share.");
    if (!token || !sameText(await sha256(token), hash)) return fail(403, "Wrong owner token.");
    return { ok: true };
  }

  async init(args: { id: string; kind: ShareKind; title: string; entry?: string; token: string }): Promise<Result<object>> {
    if (this.get("tokenHash")) return fail(409, "Share exists.");
    const now = Date.now();
    this.set("id", args.id);
    this.set("kind", args.kind);
    this.set("title", args.title);
    if (args.entry) this.set("entry", args.entry);
    this.set("tokenHash", await sha256(args.token));
    this.set("live", args.kind === "mulch");
    this.set("seq", 0);
    this.set("snapshotSeq", 0);
    this.set("createdAt", now);
    this.set("updatedAt", now);
    return { ok: true };
  }

  async info(): Promise<ShareInfo | null> {
    const id = this.get("id");
    if (!id || !this.get("tokenHash")) return null;
    return {
      id,
      kind: this.get("kind") as ShareKind,
      title: this.get("title") ?? "",
      ...(this.get("entry") ? { entry: this.get("entry") } : {}),
      live: this.get("live") === "true",
      seq: this.num("seq"),
      snapshotSeq: this.num("snapshotSeq"),
      hasSnapshot: this.get("hasSnapshot") === "true",
      createdAt: this.num("createdAt"),
      updatedAt: this.num("updatedAt"),
      files: this.sql.exec<{ path: string; size: number }>("SELECT path, size FROM files ORDER BY path").toArray(),
    };
  }

  /** Check the owner and the caps, and count the file in before it is written (so parallel uploads can't pass the cap). */
  async reserveFile(token: string | undefined, path: string, size: number): Promise<Result<{ previous: number | null }>> {
    const owner = await this.owner(token);
    if (!owner.ok) return owner;
    if (size > LIMITS.fileBytes) return fail(413, `A file can be at most ${LIMITS.fileBytes / 1_000_000} MB.`);
    const previous = this.sql.exec<{ size: number }>("SELECT size FROM files WHERE path = ?", path).toArray()[0]?.size ?? null;
    const total = this.sql.exec<{ total: number }>("SELECT COALESCE(SUM(size), 0) AS total FROM files").one().total;
    if (total - (previous ?? 0) + size > LIMITS.shareBytes) return fail(413, `A share can hold at most ${LIMITS.shareBytes / 1_000_000} MB.`);
    if (previous === null && this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM files").one().n >= LIMITS.files) return fail(413, `A share can hold at most ${LIMITS.files} files.`);
    this.sql.exec("INSERT INTO files (path, size, updated_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, updated_at = excluded.updated_at", path, size, Date.now());
    this.touch();
    return { ok: true, previous };
  }

  /** The upload failed: put the file's count back as it was. */
  async releaseFile(path: string, previous: number | null): Promise<void> {
    if (previous === null) this.sql.exec("DELETE FROM files WHERE path = ?", path);
    else this.sql.exec("UPDATE files SET size = ? WHERE path = ?", previous, path);
  }

  /** The owner's whole canvas. It includes every batch they sent before it, so it takes the current seq. */
  async putSnapshot(token: string | undefined, text: string): Promise<Result<{ seq: number }>> {
    const owner = await this.owner(token);
    if (!owner.ok) return owner;
    if (this.get("kind") !== "mulch") return fail(400, "Only a shared canvas has a snapshot.");
    let mulch: Mulch;
    try {
      mulch = JSON.parse(text);
    } catch {
      return fail(400, "The snapshot is not JSON.");
    }
    if (!mulch || typeof mulch.nodes !== "object" || typeof mulch.edges !== "object" || typeof mulch.groups !== "object") {
      return fail(400, "The snapshot must be a mulch: an object with nodes, edges and groups.");
    }
    const seq = this.num("seq");
    await this.writeSnapshot(text, seq);
    if (typeof mulch.title === "string" && mulch.title) this.set("title", mulch.title.slice(0, 200));
    this.broadcast({ type: "snapshot", seq });
    return { ok: true, seq };
  }

  private writeSnapshot(text: string, seq: number): Promise<void> {
    const id = this.get("id")!;
    const next = this.writing.then(async () => {
      if (seq < this.num("snapshotSeq")) return; // a newer one is already there
      await this.env.SHARES.put(r2Key.snapshot(id), text, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { seq: String(seq) },
      });
      this.set("snapshotSeq", seq);
      this.set("hasSnapshot", true);
      this.sql.exec("DELETE FROM batches WHERE seq <= ?", seq);
      this.touch();
    });
    this.writing = next.catch(() => undefined);
    return next;
  }

  /** Number the owner's batches, keep them, and pass them on. A batch already received (same id) is skipped. */
  async pushOps(token: string | undefined, batches: OpBatch[]): Promise<Result<{ seq: number }>> {
    const owner = await this.owner(token);
    if (!owner.ok) return owner;
    if (this.get("kind") !== "mulch") return fail(400, "Only a shared canvas takes changes.");
    if (this.get("hasSnapshot") !== "true") return fail(409, "Upload the snapshot first (PUT /api/shares/:id/snapshot).");
    if (this.get("live") !== "true") return fail(409, "Sharing is not live. Turn it on with PUT /api/shares/:id/live.");
    let seq = this.num("seq");
    for (const batch of batches) {
      if (!batch || typeof batch.id !== "string" || !Array.isArray(batch.ops)) return fail(400, "Each batch needs an id and an ops array.");
      if (this.sql.exec("SELECT 1 FROM batches WHERE id = ?", batch.id).toArray().length) continue;
      seq += 1;
      this.sql.exec("INSERT INTO batches (seq, id, body) VALUES (?, ?, ?)", seq, batch.id, JSON.stringify(batch));
      this.set("seq", seq);
      this.broadcast({ type: "ops", seq, batch });
    }
    this.touch();
    const waiting = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM batches").one().n;
    if (waiting >= COMPACT_AFTER_BATCHES) this.ctx.waitUntil(this.compact());
    else if (waiting && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + COMPACT_DELAY_MS);
    return { ok: true, seq };
  }

  async setLive(token: string | undefined, live: boolean): Promise<Result<object>> {
    const owner = await this.owner(token);
    if (!owner.ok) return owner;
    if (this.get("kind") !== "mulch") return fail(400, "Only a shared canvas can be live.");
    this.set("live", live);
    this.touch();
    this.broadcast({ type: "live", live });
    return { ok: true };
  }

  async destroy(token: string | undefined): Promise<Result<object>> {
    const owner = await this.owner(token);
    if (!owner.ok) return owner;
    const id = this.get("id")!;
    let cursor: string | undefined;
    do {
      const page = await this.env.SHARES.list({ prefix: r2Key.prefix(id), cursor });
      if (page.objects.length) await this.env.SHARES.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    this.broadcast({ type: "deleted" });
    for (const socket of this.ctx.getWebSockets()) socket.close(4404, "deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.schema(); // this instance may still be asked about the share: it no longer exists
    return { ok: true };
  }

  async alarm(): Promise<void> {
    await this.compact();
  }

  /** Fold the waiting batches into the snapshot. */
  private async compact(): Promise<void> {
    const id = this.get("id");
    if (!id) return;
    const rows = this.sql.exec<{ seq: number; body: string }>("SELECT seq, body FROM batches ORDER BY seq").toArray();
    if (!rows.length) return;
    const stored = await this.env.SHARES.get(r2Key.snapshot(id));
    if (!stored) return;
    const from = Number(stored.customMetadata?.seq ?? 0);
    let mulch = (await stored.json()) as Mulch;
    let seq = from;
    for (const row of rows) {
      if (row.seq <= from) continue;
      const batch = JSON.parse(row.body) as OpBatch;
      mulch = applyOps(mulch, batch.ops, batch.at);
      seq = row.seq;
    }
    if (seq > from) await this.writeSnapshot(JSON.stringify(mulch), seq);
  }

  private broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(text);
      } catch {
        // A socket closing as we send; its close handler tidies up.
      }
    }
  }

  /** A viewer connecting: hello, then every batch the snapshot doesn't hold yet. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket.", { status: 426 });
    const info = await this.info();
    if (!info || info.kind !== "mulch") return new Response("Not found.", { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "hello", kind: info.kind, title: info.title, live: info.live, seq: info.seq, snapshotSeq: info.snapshotSeq }));
    for (const row of this.sql.exec<{ seq: number; body: string }>("SELECT seq, body FROM batches WHERE seq > ? ORDER BY seq", info.snapshotSeq)) {
      server.send(`{"type":"ops","seq":${row.seq},"batch":${row.body}}`);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(): Promise<void> {
    // Viewers only listen (pings are answered without waking the room).
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    try {
      socket.close(code === 1005 ? 1000 : code, "closed");
    } catch {
      // already closed
    }
  }
}

/** Counts new shares per install (or per address), per hour. */
export class CreateLimiter extends DurableObject<Env> {
  async take(limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const start = (await this.ctx.storage.get<number>("start")) ?? 0;
    let count = (await this.ctx.storage.get<number>("count")) ?? 0;
    if (now - start >= windowMs) {
      await this.ctx.storage.put({ start: now, count: 1 });
      return true;
    }
    if (count >= limit) return false;
    count += 1;
    await this.ctx.storage.put("count", count);
    return true;
  }
}
