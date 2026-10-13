/**
 * mlch.app: the landing page, the sharing API, and shared things on
 * share.mlch.app (a separate origin, so nothing shared ever runs on the
 * landing page's origin).
 *
 * A share is reached by a long random link, and changed only with the owner
 * token the app got when it created it. Who may make new shares: a
 * self-hosted server's key, or on mlch.app a subscribed account
 * (accounts.ts). API in README.md.
 */

import { LIMITS, type Env, type ShareKind } from "./env";
import { FAVICON_DATA_URL } from "./favicon";
import { frameCsp, framePage } from "./frame";
import { fileHeaders, mimeOf, ownSources, sandboxCsp, validPath } from "./files";
import { r2Key, type Result } from "./room";
import { accountRoutes, accountsOn, mayCreate, recordShare } from "./accounts";
import { adminRoutes } from "./admin";
import type { OpBatch } from "../../src/lib/mulch/types";
import { artifactKindOf } from "../../src/lib/artifacts/kind";

export { ShareRoom, CreateLimiter } from "./room";

const ID = /^[A-Za-z0-9]{22,64}$/;
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Uniformly random base62 (rejection sampling, so no letter is likelier than another). */
export function randomId(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < 248 && out.length < length) out += BASE62[byte % 62];
    }
  }
  return out;
}

const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const error = (status: number, message: string) => json(status, { error: message });
const notFound = () => new Response("Not found.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

function failed(result: Result<object>): Response | undefined {
  return result.ok ? undefined : error(result.status, result.error);
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A request body as text, refused past `limit` bytes without reading it all. */
async function readText(request: Request, limit: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("Content-Length") ?? NaN);
  if (declared > limit) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

const room = (env: Env, id: string) => env.ROOMS.get(env.ROOMS.idFromName(id));

function viewerCsp(env: Env): string {
  const socket = env.SHARE_ORIGIN.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    `connect-src 'self' ${socket}`,
    // Video cards play YouTube and Vimeo in place (src/lib/ingest/video.ts PLAYER_ORIGINS).
    "frame-src 'self' https://www.youtube.com https://player.vimeo.com",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

async function asset(env: Env, request: Request, path: string, extra: Record<string, string> = {}): Promise<Response> {
  const response = await env.ASSETS.fetch(new Request(new URL(path, request.url), { headers: request.headers }));
  const out = new Response(response.body, response);
  for (const [key, value] of Object.entries(extra)) out.headers.set(key, value);
  return out;
}

/** A file from a share's R2 folder, sandboxed. */
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Link previews (Slack, iMessage, email): title, description and picture in
 * the page's head. The picture is the one the app uploaded with the share
 * (preview.png: the canvas, or the file's first page), else the mlch icon.
 * Wording is placeholder (George).
 */
export function withPreviewMeta(html: string, meta: { title: string; description: string; image: string; url: string }): string {
  const tags = [
    ["og:type", "website"],
    ["og:site_name", "mlch"],
    ["og:title", meta.title],
    ["og:description", meta.description],
    ["og:image", meta.image],
    ["og:url", meta.url],
  ]
    .map(([property, content]) => `<meta property="${property}" content="${escapeHtml(content)}">`)
    .concat(`<meta name="twitter:card" content="summary_large_image">`, `<meta name="description" content="${escapeHtml(meta.description)}">`)
    .join("");
  const titled = html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(meta.title)}</title>`);
  // At the end of the head, so the page's charset stays first.
  const end = titled.search(/<\/head>/i);
  return end >= 0 ? titled.slice(0, end) + tags + titled.slice(end) : tags + titled;
}

async function previewMeta(env: Env, id: string, title: string, kind: ShareKind): Promise<{ title: string; description: string; image: string; url: string }> {
  const hasPreview = !!(await env.SHARES.head(r2Key.file(id, "preview.png")).catch(() => null));
  return {
    title: title || "mlch",
    description: kind === "mulch" ? "A canvas shared from mlch." : "Shared from mlch.",
    image: hasPreview ? `${env.SHARE_ORIGIN}/s/${id}/preview.png` : `${env.SHARE_ORIGIN}/brand/og.png`,
    url: `${env.SHARE_ORIGIN}/s/${id}/`,
  };
}

/** The mlch icon as the tab icon of a shared page that has none. */
export function withFavicon(html: string): string {
  if (/<link[^>]+rel=["']?(shortcut )?icon/i.test(html)) return html;
  const link = `<link rel="icon" type="image/png" href="${FAVICON_DATA_URL}">`;
  const head = /<head[^>]*>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + link + html.slice(head.index + head[0].length) : link + html;
}

async function serveFile(env: Env, request: Request, id: string, path: string): Promise<Response> {
  if (!validPath(path)) return notFound();
  const object = await env.SHARES.get(r2Key.file(id, path), { onlyIf: request.headers });
  if (!object) return notFound();
  const headers = fileHeaders(path, sandboxCsp(ownSources(env.SHARE_ORIGIN, id)));
  headers.set("ETag", object.httpEtag);
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  // A shared page's sandbox allows only data: images, so the tab icon goes in as one (unless the page has its own).
  if (mimeOf(path).startsWith("text/html")) {
    const html = withFavicon(await object.text());
    headers.set("Content-Length", String(new TextEncoder().encode(html).length));
    return new Response(request.method === "HEAD" ? null : html, { headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

// ---------------------------------------------------------------- API

async function createShare(request: Request, env: Env): Promise<Response> {
  // Who may, before what: the app checks a server's key with an empty request (400 once the key is right).
  const allowed = await mayCreate(request, env);
  if (!allowed.ok) return allowed.response;
  const body = (await request.json().catch(() => undefined)) as { kind?: string; title?: string; entry?: string } | undefined;
  const kind = body?.kind as ShareKind;
  if (kind !== "artifact" && kind !== "mulch") return error(400, 'kind must be "artifact" or "mulch".');
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, LIMITS.titleChars) : "";
  const entry = body?.entry;
  if (kind === "artifact" && (typeof entry !== "string" || !validPath(entry))) return error(400, "An artifact share needs entry: the path of its main file, e.g. deck.html.");
  const install = request.headers.get("X-Mlch-Install")?.slice(0, 200);
  const who = install ? `install:${await sha256(install)}` : `ip:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`;
  const limiter = env.LIMITER.get(env.LIMITER.idFromName(who));
  if (!(await limiter.take(LIMITS.createsPerHour, 3_600_000))) return error(429, "Too many new shares from this install. Try again within the hour.");
  const id = randomId(24);
  const ownerToken = randomId(40);
  const result = await room(env, id).init({ id, kind, title, ...(kind === "artifact" ? { entry } : {}), token: ownerToken });
  if (!result.ok) return error(result.status, result.error);
  if (allowed.userId) await recordShare(env, id, allowed.userId, kind);
  return json(201, { id, ownerToken, url: `${env.SHARE_ORIGIN}/s/${id}/`, manifestUrl: `${env.SHARE_ORIGIN}/api/shares/${id}/manifest` });
}

async function manifest(env: Env, id: string): Promise<Response> {
  const info = await room(env, id).info();
  if (!info) return error(404, "No such share.");
  const base = `${env.SHARE_ORIGIN}/s/${id}/`;
  return json(200, {
    id,
    kind: info.kind,
    title: info.title,
    ...(info.entry ? { entry: info.entry } : {}),
    live: info.live,
    seq: info.seq,
    url: base,
    ...(info.kind === "mulch" && info.hasSnapshot ? { snapshotUrl: `${base}snapshot.json` } : {}),
    files: info.files.map((file) => ({ ...file, url: `${base}${file.path.split("/").map(encodeURIComponent).join("/")}` })),
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
  });
}

async function api(request: Request, env: Env, parts: string[]): Promise<Response> {
  // parts: ["api", "shares", id?, ...rest]
  const method = request.method;
  if (parts.length === 2) return method === "POST" ? createShare(request, env) : error(405, "POST to create a share.");
  const id = parts[2];
  if (!ID.test(id)) return error(404, "No such share.");
  const rest = parts.slice(3);
  const token = bearer(request);
  const stub = room(env, id);

  if (rest.length === 0) {
    if (method !== "DELETE") return error(405, "DELETE to remove a share.");
    return failed(await stub.destroy(token)) ?? json(200, { deleted: true });
  }
  if (rest[0] === "manifest" && rest.length === 1) return method === "GET" ? manifest(env, id) : error(405, "GET the manifest.");

  if (rest[0] === "files" && rest.length > 1) {
    if (method !== "PUT") return error(405, "PUT a file.");
    const path = rest.slice(1).map(decodeURIComponent).join("/");
    if (!validPath(path)) return error(400, "File paths are plain names in folders (letters, digits, . _ - and spaces), like assets/ab12.png.");
    const size = Number(request.headers.get("Content-Length") ?? NaN);
    if (!Number.isFinite(size) || size < 0) return error(411, "Send Content-Length.");
    const reserved = await stub.reserveFile(token, path, size);
    if (!reserved.ok) return error(reserved.status, reserved.error);
    try {
      const stored = await env.SHARES.put(r2Key.file(id, path), request.body ?? new Uint8Array());
      if (!stored || stored.size !== size) throw new Error("size mismatch");
    } catch {
      await stub.releaseFile(path, reserved.previous);
      return error(400, "Upload failed or did not match Content-Length.");
    }
    return json(200, { path, size });
  }

  if (rest[0] === "snapshot" && rest.length === 1) {
    if (method !== "PUT") return error(405, "PUT the snapshot.");
    const text = await readText(request, LIMITS.snapshotBytes);
    if (text === undefined) return error(413, `A snapshot can be at most ${LIMITS.snapshotBytes / 1_000_000} MB.`);
    const result = await stub.putSnapshot(token, text);
    return result.ok ? json(200, { seq: result.seq }) : error(result.status, result.error);
  }

  if (rest[0] === "ops" && rest.length === 1) {
    if (method !== "POST") return error(405, "POST op batches.");
    const text = await readText(request, LIMITS.opsBytes);
    if (text === undefined) return error(413, `Send at most ${LIMITS.opsBytes / 1_000_000} MB of ops at a time.`);
    let body: { batch?: OpBatch; batches?: OpBatch[] };
    try {
      body = JSON.parse(text);
    } catch {
      return error(400, "Send JSON: { batches: [...] } or { batch }.");
    }
    const batches = body.batches ?? (body.batch ? [body.batch] : undefined);
    if (!Array.isArray(batches)) return error(400, "Send JSON: { batches: [...] } or { batch }.");
    const result = await stub.pushOps(token, batches);
    return result.ok ? json(200, { seq: result.seq }) : error(result.status, result.error);
  }

  if (rest[0] === "live" && rest.length === 1) {
    if (method !== "PUT") return error(405, "PUT { live: true | false }.");
    const body = (await request.json().catch(() => undefined)) as { live?: unknown } | undefined;
    if (typeof body?.live !== "boolean") return error(400, "Send { live: true } or { live: false }.");
    return failed(await stub.setLive(token, body.live)) ?? json(200, { live: body.live });
  }

  return error(404, "Unknown API path.");
}

// ---------------------------------------------------------------- share host

async function shareHost(request: Request, env: Env, url: URL, parts: string[]): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") return error(405, "Shared things are read-only.");
  // parts: ["s", id, ...] or ["api", "mulches", id, ...]
  const id = parts[0] === "s" ? parts[1] : parts[2];
  if (!id || !ID.test(id)) return notFound();

  if (parts[0] === "s") {
    // /s/:id → /s/:id/, so a page's relative links resolve inside the share.
    if (parts.length === 2 && !url.pathname.endsWith("/")) return Response.redirect(`${env.SHARE_ORIGIN}/s/${id}/`, 301);
    const rest = parts.slice(2);
    if (rest.length === 0) {
      const info = await room(env, id).info();
      if (!info) return notFound();
      if (info.kind === "mulch") {
        const page = await asset(env, request, "/viewer/", {
          "Content-Security-Policy": viewerCsp(env),
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-cache",
        });
        if (!page.ok || request.method === "HEAD") return page;
        const html = withPreviewMeta(await page.text(), await previewMeta(env, id, info.title, "mulch"));
        const headers = new Headers(page.headers);
        headers.delete("Content-Length");
        return new Response(html, { status: 200, headers });
      }
      // Pages and drawings open in a frame page with Full screen; other files as themselves.
      if (/\.(html?|svg)$/i.test(info.entry!)) {
        const nonce = randomId(16);
        // A deck or a page, as the file declares (or looks, for files made before kinds).
        const file = /\.html?$/i.test(info.entry!) ? await env.SHARES.get(r2Key.file(id, info.entry!)) : null;
        const kind = file ? artifactKindOf(await file.text()) : "page";
        const page = withPreviewMeta(framePage(info.title, info.entry!, nonce, kind),await previewMeta(env, id, info.title, "artifact"));
        return new Response(request.method === "HEAD" ? null : page, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": frameCsp(nonce), "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" },
        });
      }
      return serveFile(env, request, id, info.entry!);
    }
    if (rest.length === 1 && rest[0] === "live") return room(env, id).fetch(request);
    if (rest.length === 1 && rest[0] === "snapshot.json") {
      const object = await env.SHARES.get(r2Key.snapshot(id));
      if (!object) return notFound();
      return new Response(object.body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Mlch-Seq": object.customMetadata?.seq ?? "0",
          "Access-Control-Expose-Headers": "X-Mlch-Seq",
        },
      });
    }
    return serveFile(env, request, id, rest.map(decodeURIComponent).join("/"));
  }

  // /api/mulches/:id/<path>: where the app's canvas components look for a
  // mulch's files. The viewer gives them the share id as the mulch id.
  const rest = parts.slice(3);
  if (rest[0] === "thumbnail" && rest.length === 1) {
    const doc = url.searchParams.get("doc") ?? "";
    return serveFile(env, request, id, `thumbnails/${doc}.png`);
  }
  return serveFile(env, request, id, rest.map(decodeURIComponent).join("/"));
}

// ---------------------------------------------------------------- router

const LEGAL = new Set(["privacy", "terms", "refunds", "company"]);

const ADMIN_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

/** GET /api/server: what the app needs to know about a server before using it. */
function serverInfo(env: Env) {
  return { mlch: 1, auth: env.SERVER_KEY ? "key" : accountsOn(env) ? "account" : "none" };
}

/** A self-hosted server may leave the origins unset: then everything is on the address it was reached at. */
function withOrigins(env: Env, url: URL): Env {
  if (env.APEX_ORIGIN && env.SHARE_ORIGIN) return env;
  return { ...env, APEX_ORIGIN: env.APEX_ORIGIN || url.origin, SHARE_ORIGIN: env.SHARE_ORIGIN || env.APEX_ORIGIN || url.origin };
}

export async function handle(request: Request, givenEnv: Env): Promise<Response> {
  const url = new URL(request.url);
  const env = withOrigins(givenEnv, url);
  const apex = new URL(env.APEX_ORIGIN);
  const share = new URL(env.SHARE_ORIGIN);
  if (url.host === `www.${apex.host}`) return Response.redirect(`${env.APEX_ORIGIN}${url.pathname}${url.search}`, 301);
  const parts = url.pathname.split("/").filter(Boolean);
  const onShareHost = url.host === share.host;

  if (parts[0] === "api" && parts[1] === "shares") {
    const tooOld = outdatedApp(request, env);
    if (tooOld) return tooOld;
    return api(request, env, parts);
  }
  if (parts[0] === "api" && parts[1] === "server" && parts.length === 2) return json(200, serverInfo(env));
  const account = await accountRoutes(request, env, url, parts);
  if (account) return account;
  if (!onShareHost || share.host === apex.host) {
    const admin = await adminRoutes(request, env, parts, (path) => asset(env, request, path, ADMIN_HEADERS));
    if (admin) return admin;
  }

  const shared = parts[0] === "s" || (parts[0] === "api" && parts[1] === "mulches" && parts.length > 2);
  if (shared) {
    if (!onShareHost) return Response.redirect(`${env.SHARE_ORIGIN}${url.pathname}${url.search}`, 301);
    return shareHost(request, env, url, parts);
  }

  // App updates (electron-updater, generic provider): R2 releases/mac/… — latest-mac.yml, the zip, its blockmap.
  if (parts[0] === "releases" && parts[1] === "mac" && parts.length === 3 && request.method === "GET" && /^[\w.-]+$/.test(parts[2])) {
    const object = await env.SHARES.get(`releases/mac/${parts[2]}`);
    if (!object) return notFound();
    const name = parts[2];
    const type = name.endsWith(".yml") ? "text/yaml; charset=utf-8" : name.endsWith(".dmg") ? "application/x-apple-diskimage" : "application/octet-stream";
    // The feeds and mlch.dmg (the current download) change; versioned files never do.
    const changing = name.endsWith(".yml") || name === "mlch.dmg";
    return new Response(object.body, {
      headers: {
        "Content-Type": type,
        "Content-Length": String(object.size),
        "Cache-Control": changing ? "no-cache" : "public, max-age=31536000, immutable",
        ...(name.endsWith(".dmg") ? { "Content-Disposition": `attachment; filename="${name === "mlch.dmg" ? "mlch.dmg" : name}"` } : {}),
      },
    });
  }
  // The landing page's Download: the current release's disk image.
  if (url.pathname === "/download" && !onShareHost) return Response.redirect(`${url.origin}/releases/mac/mlch.dmg`, 302);
  if (parts[0] === "viewer" || parts[0] === "brand") return env.ASSETS.fetch(request);
  // How to run your own server (linked from the app's Settings, Sharing).
  if (url.pathname === "/server" || url.pathname === "/server/") return asset(env, request, "/server/", { "Cache-Control": "public, max-age=300" });
  // Legal pages (landing/legal/) and their stylesheet.
  if (parts.length === 1 && LEGAL.has(parts[0]) && !onShareHost) return asset(env, request, `/${parts[0]}/`, { "Cache-Control": "public, max-age=300" });
  if (url.pathname === "/site.css") return asset(env, request, "/site.css", { "Cache-Control": "public, max-age=300" });
  if (url.pathname === "/favicon.ico") return Response.redirect(`${url.origin}/brand/icon-32.png`, 301);
  if (url.pathname === "/") {
    if (onShareHost && share.host !== apex.host) return Response.redirect(`${env.APEX_ORIGIN}/`, 301);
    return asset(env, request, "/", { "Cache-Control": "public, max-age=300" });
  }
  return notFound();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (cause) {
      console.error("request failed", request.method, new URL(request.url).pathname, cause);
      return error(500, "Something went wrong.");
    }
  },
} satisfies ExportedHandler<Env>;

/** Compares dotted versions (1.10.0 > 1.9.2). */
export function olderVersion(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** A change to shares from an app older than MIN_APP_VERSION: 426 with what to do. Reading is never refused. */
function outdatedApp(request: Request, env: Env): Response | undefined {
  const version = request.headers.get("X-Mlch-Version");
  if (!env.MIN_APP_VERSION || !version || request.method === "GET") return undefined;
  return olderVersion(version, env.MIN_APP_VERSION) ? json(426, { error: "Update mlch to keep sharing (mlch menu, Check for Updates)." }) : undefined;
}
