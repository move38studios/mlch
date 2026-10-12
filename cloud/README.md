# mlch cloud

One Cloudflare Worker (account "move38 account", `a7b1e373a9581b6f04e2a48d3abc9aa3`):

- **mlch.app**: the placeholder landing page (the wordmark, nothing else) and the sharing API. `www.mlch.app` redirects to it.
- **share.mlch.app**: shared things, on their own origin so nothing shared ever runs on mlch.app.

Sharing has no accounts. A share is a long random link; creating one returns an **owner token**, the only way to change or delete it. The app keeps it (server-side) with the mulch.

## Layout

- `src/index.ts`: routing, API, serving files.
- `src/room.ts`: `ShareRoom`, one Durable Object per share (owner token hash, file sizes, live state), and `CreateLimiter` (new shares per install per hour).
- `src/files.ts`: paths, types, and the sandbox CSP (the app's `ARTIFACT_CSP` plus the share's own files; `src/lib/share/__tests__/client.test.ts` keeps them in step).
- `landing/`: the landing page. `viewer/`: the read-only canvas for shared mulches, built with Vite from the app's own components (`@/components/canvas/*`).
- `scripts/build.mjs` → `dist/` (landing, `brand/` from `public/brand`, `viewer/`), served as static assets.

## Commands (in cloud/)

```sh
npm install --legacy-peer-deps
npm run dev        # build, then wrangler dev on http://localhost:8787 (one host for everything)
npm run check      # typecheck worker + viewer, build, tests (inside workerd: R2 and Durable Objects simulated)
```

The app points at a local server with `MLCH_SHARE_URL=http://localhost:8787`.

## Deploy (first time)

```sh
cd cloud
npx wrangler r2 bucket create mlch-shares
npm run deploy     # check, then wrangler deploy
```

`wrangler deploy` attaches the custom domains in `wrangler.jsonc` (`mlch.app`, `www.mlch.app`, `share.mlch.app`) and creates their DNS records. If the zone already has DNS records for those names, remove them first or the deploy refuses. The Durable Object classes are created by migration `v1`.

After that, `npm run deploy` for every change. Logs: `npx wrangler tail` or Workers observability in the dashboard.

## API

All JSON. The owner token goes in `Authorization: Bearer <token>`. Errors are `{ error }` with a message saying what is allowed.

| Request | Who | Does |
|---|---|---|
| `POST /api/shares` `{ kind: "artifact" \| "mulch", title, entry? }` | anyone (60 per hour per `X-Mlch-Install`, else per address) | Creates a share. `entry` (artifacts only): the main file's path. Returns `{ id, ownerToken, url, manifestUrl }`. |
| `PUT /api/shares/:id/files/<path>` | owner | Stores a file. `Content-Length` required. At most 25 MB per file, 300 MB and 2,000 files per share. Paths: plain names in folders (`assets/ab12.png`, `artifacts/deck.html`). |
| `PUT /api/shares/:id/snapshot` (mulch JSON) | owner | The whole canvas (at most 20 MB). Takes the current seq. Needed before ops. |
| `POST /api/shares/:id/ops` `{ batches: OpBatch[] }` | owner | Numbers each batch (seq) and sends it to viewers. A batch id already received is skipped, so retries are safe. Refused (409) when not live or before the snapshot. |
| `PUT /api/shares/:id/live` `{ live }` | owner | Live updates on or off. Viewers keep the last state. |
| `DELETE /api/shares/:id` | owner | Deletes the share and all its files. Viewers are told. |
| `GET /api/shares/:id/manifest` | anyone | `{ id, kind, title, entry?, live, seq, url, snapshotUrl?, files: [{ path, size, url }], createdAt, updatedAt }`, for "Open in mlch". |

Errors: 400 bad input, 403 wrong token, 404 no such share, 409 not live / no snapshot yet, 411 no Content-Length, 413 too big, 429 too many new shares.

On share.mlch.app:

| Path | Serves |
|---|---|
| `/s/:id/` | An artifact's main file, or the viewer for a canvas. |
| `/s/:id/<path>` | A file of the share. |
| `/s/:id/snapshot.json` | The canvas snapshot; header `X-Mlch-Seq` says which batches it holds. |
| `/s/:id/live` | WebSocket: `hello { title, live, seq, snapshotSeq }`, then every batch after `snapshotSeq` as `ops { seq, batch }`, then live ones; `snapshot { seq }` (refetch), `live { live }`, `deleted`. |
| `/api/mulches/:id/<path>` | The same files, where the app's canvas components look for them. Deck previews: `thumbnails/<docPath>.png` (via `?doc=` on `/thumbnail`). |

Every shared file is served by its name's type (never the uploader's), HTML and SVG under the app's artifact sandbox (opaque origin, no network, forms or navigation; images and media also from the share itself). Office files download; PDFs open in the browser's viewer.

The room folds batches into the snapshot 20 s after the last one, or once 200 are waiting, using the app's own `applyOps`.

## Not done yet

- Expiry of old shares (they stay until deleted).
- Reporting abuse; a rate limit on uploads beyond the per-share caps.
- Collaboration (several writers): the room already orders batches; it needs per-person origins, presence and edit locks (docs/PLAN-2.md M8).
