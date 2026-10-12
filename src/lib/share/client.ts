/**
 * Talking to mlch.app's sharing API (cloud/, API in cloud/README.md).
 * Server-only: the owner token never reaches the page.
 *
 * A share is a long random link (no accounts). Creating one returns an owner
 * token, the only way to change or delete it; keep it with the mulch.
 *
 *   const client = shareClient({ install });
 *   const share = await client.create({ kind: "mulch", title });
 *   await client.uploadFile(share, "assets/ab12.png", bytes);
 *   await client.uploadSnapshot(share, mulch);
 *   const sender = client.liveSender(share);  sender.send(batch) …
 *
 * Shared canvases find their files where the app's cards look for them, so
 * upload them under the same paths as in the mulch folder (assets/…,
 * artifacts/…, docs/…), and deck previews under thumbnailPath(docPath).
 */

import type { Mulch, OpBatch } from "@/lib/mulch/types";

export type ShareKind = "artifact" | "mulch";

export interface Share {
  id: string;
  ownerToken: string;
  /** The link to give people. */
  url: string;
  /** What "Open in mlch" reads (public). */
  manifestUrl: string;
}

export interface Manifest {
  id: string;
  kind: ShareKind;
  title: string;
  entry?: string;
  live: boolean;
  seq: number;
  url: string;
  snapshotUrl?: string;
  files: Array<{ path: string; size: number; url: string }>;
  createdAt: number;
  updatedAt: number;
}

export class ShareError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ShareError";
  }
}

export const DEFAULT_SHARE_URL = "https://mlch.app";

/** Where a deck or document's preview image goes in a share. */
export function thumbnailPath(docPath: string): string {
  return `thumbnails/${docPath}.png`;
}

export interface ShareClientOptions {
  /** The API's origin. Default: MLCH_SHARE_URL, else https://mlch.app. */
  base?: string;
  /** A stable id for this install (new shares are counted per install). */
  install?: string;
  fetch?: typeof fetch;
}

export interface LiveSender {
  /** Queue a batch; batches go out in order, a few at a time. */
  send(batch: OpBatch): void;
  /** Resolves when everything queued so far has been sent (or sending stopped). */
  flush(): Promise<void>;
  /** Why sending stopped (wrong token, share gone, not live), if it did. */
  readonly stopped?: ShareError;
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export function shareClient(options: ShareClientOptions = {}) {
  const base = (options.base ?? process.env.MLCH_SHARE_URL ?? DEFAULT_SHARE_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  async function request<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
    const { token, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (options.install) headers.set("X-Mlch-Install", options.install);
    const response = await doFetch(`${base}${path}`, { ...rest, headers });
    const body = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new ShareError(response.status, body.error || `Sharing failed (${response.status}).`);
    return body;
  }

  const client = {
    base,

    create(input: { kind: ShareKind; title: string; entry?: string }): Promise<Share> {
      return request<Share>("/api/shares", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    },

    uploadFile(share: Share, path: string, bytes: Uint8Array): Promise<{ path: string; size: number }> {
      return request(`/api/shares/${share.id}/files/${encodePath(path)}`, {
        method: "PUT",
        token: share.ownerToken,
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.byteLength) },
        body: bytes as BodyInit,
      });
    },

    /** The whole canvas. Upload it before any ops, and again whenever it's simpler than ops (e.g. after reconnecting). */
    uploadSnapshot(share: Share, mulch: Mulch): Promise<{ seq: number }> {
      return request(`/api/shares/${share.id}/snapshot`, {
        method: "PUT",
        token: share.ownerToken,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mulch),
      });
    },

    pushOps(share: Share, batches: OpBatch[]): Promise<{ seq: number }> {
      return request(`/api/shares/${share.id}/ops`, {
        method: "POST",
        token: share.ownerToken,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batches }),
      });
    },

    /** Turn live updates off (viewers see the last state) or back on. */
    setLive(share: Share, live: boolean): Promise<{ live: boolean }> {
      return request(`/api/shares/${share.id}/live`, { method: "PUT", token: share.ownerToken, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ live }) });
    },

    remove(share: Share): Promise<{ deleted: true }> {
      return request(`/api/shares/${share.id}`, { method: "DELETE", token: share.ownerToken });
    },

    /** A share's public manifest, from its manifest link (for Open in mlch). */
    async manifest(manifestUrl: string): Promise<Manifest> {
      const response = await doFetch(manifestUrl);
      const body = (await response.json().catch(() => ({}))) as Manifest & { error?: string };
      if (!response.ok) throw new ShareError(response.status, body.error || `Not found (${response.status}).`);
      return body;
    },

    /**
     * Sends a live canvas's op batches in order. Network failures and server
     * errors are retried with backoff (the room skips batches it already has);
     * a refusal (403, 404, 409: wrong token, gone, not live or no snapshot)
     * stops the sender.
     */
    liveSender(share: Share, sender: { maxBatch?: number; retryMs?: number[] } = {}): LiveSender {
      const queue: OpBatch[] = [];
      const backoff = sender.retryMs ?? [500, 1000, 2000, 5000, 10_000, 30_000];
      let running: Promise<void> | undefined;
      let stopped: ShareError | undefined;

      async function run() {
        let attempt = 0;
        while (queue.length && !stopped) {
          const next = queue.slice(0, sender.maxBatch ?? 50);
          try {
            await client.pushOps(share, next);
            queue.splice(0, next.length);
            attempt = 0;
          } catch (cause) {
            if (cause instanceof ShareError && cause.status >= 400 && cause.status < 500 && cause.status !== 429) {
              stopped = cause;
              queue.length = 0;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, backoff[Math.min(attempt++, backoff.length - 1)]));
          }
        }
        running = undefined;
      }

      return {
        send(batch) {
          if (stopped) return;
          queue.push(batch);
          running ??= run();
        },
        flush: () => running ?? Promise.resolve(),
        get stopped() {
          return stopped;
        },
      };
    },
  };
  return client;
}

export type ShareClient = ReturnType<typeof shareClient>;
