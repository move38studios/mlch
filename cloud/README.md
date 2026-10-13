# mlch cloud

The mlch server: one Cloudflare Worker. It runs two ways from the same code:

- **mlch.app** (`wrangler.mlch.jsonc`, account "move38 account", `a7b1e373a9581b6f04e2a48d3abc9aa3`): the placeholder landing page, the sharing API, accounts and subscriptions. `www.mlch.app` redirects to it; **share.mlch.app** serves shared things on their own origin so nothing shared ever runs on mlch.app.
- **Your own server** (`wrangler.jsonc`): the same sharing on someone's own Cloudflare account, on its workers.dev address, without accounts: new shares need the server's key (`SERVER_KEY`). `npm run deploy:own`; the guide for people is `landing/server.html` (mlch.app/server).

A share is a long random link; anyone with it can view. Creating one returns an **owner token**, the only way to change or delete it; the app keeps it (server-side) with the mulch, with the server it lives on. Who may create one: on mlch.app a signed-in account with an active subscription (`src/accounts.ts`), on an own server whoever has its key, on a local dev server anyone.

## Layout

- `src/index.ts`: routing, API, serving files.
- `src/accounts.ts`: Google sign-in for the app, sessions, Stripe Checkout, the billing page and Stripe's webhook (D1: users, sessions, sign-ins, grants, shares; tables made on first use).
- `src/room.ts`: `ShareRoom`, one Durable Object per share (owner token hash, file sizes, live state), and `CreateLimiter` (new shares per install per hour).
- `src/files.ts`: paths, types, and the sandbox CSP (the app's `ARTIFACT_CSP` plus the share's own files; `src/lib/share/__tests__/client.test.ts` keeps them in step).
- `landing/`: the landing page. `viewer/`: the read-only canvas for shared mulches, built with Vite from the app's own components (`@/components/canvas/*`).
- `scripts/build.mjs` → `dist/` (landing, `brand/` from `public/brand`, `viewer/`), served as static assets.

## Commands (in cloud/)

```sh
npm install --legacy-peer-deps
npm run dev        # build, then mlch.app's config on http://localhost:8787 (one host for everything; /auth/dev signs in without Google)
npm run dev:own    # an own server on :8787 with SERVER_KEY dev-key
npm run check      # typecheck worker + viewer, build, tests (inside workerd: R2 and Durable Objects simulated)
```

The app points at a local mlch.app with `MLCH_SHARE_URL=http://localhost:8787` (add `MLCH_DEV_SIGN_IN=you@example.com` so Sign in uses /auth/dev), or at an own server through Settings, Sharing.

## Deploy mlch.app

Secrets (once, `npx wrangler secret put NAME -c wrangler.mlch.jsonc`): `GOOGLE_CLIENT_SECRET` (Google Cloud project mlch-511514, OAuth client "mlch.app"), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (endpoint `https://mlch.app/api/stripe/webhook`, events `customer.subscription.*`). Vars in `wrangler.mlch.jsonc`: `ACCOUNTS`, `GOOGLE_CLIENT_ID`, `STRIPE_PRICE` (the price's lookup key). D1 database `mlch-accounts`.

### First time

```sh
cd cloud
npx wrangler r2 bucket create mlch-shares
npm run deploy     # check, then wrangler deploy -c wrangler.mlch.jsonc
```

`wrangler deploy` attaches the custom domains in `wrangler.mlch.jsonc` (`mlch.app`, `www.mlch.app`, `share.mlch.app`) and creates their DNS records. If the zone already has DNS records for those names, remove them first or the deploy refuses. The Durable Object classes are created by migration `v1`.

After that, `npm run deploy` for every change. Logs: `npx wrangler tail` or Workers observability in the dashboard.

## API

All JSON. The owner token goes in `Authorization: Bearer <token>`. Errors are `{ error }` with a message saying what is allowed.

| Request | Who | Does |
|---|---|---|
| `GET /api/server` | anyone | `{ mlch: 1, auth: "account" \| "key" \| "none" }`: what making a share needs. |
| `POST /api/shares` `{ kind: "artifact" \| "mulch", title, entry? }` | `X-Mlch-Auth`: the session (mlch.app) or the server's key (own server); 60 per hour per `X-Mlch-Install`, else per address | Creates a share. `entry` (artifacts only): the main file's path. Returns `{ id, ownerToken, url, manifestUrl }`. |
| `PUT /api/shares/:id/files/<path>` | owner | Stores a file. `Content-Length` required. At most 25 MB per file, 300 MB and 2,000 files per share. Paths: plain names in folders (`assets/ab12.png`, `artifacts/deck.html`). |
| `PUT /api/shares/:id/snapshot` (mulch JSON) | owner | The whole canvas (at most 20 MB). Takes the current seq. Needed before ops. |
| `POST /api/shares/:id/ops` `{ batches: OpBatch[] }` | owner | Numbers each batch (seq) and sends it to viewers. A batch id already received is skipped, so retries are safe. Refused (409) when not live or before the snapshot. |
| `PUT /api/shares/:id/live` `{ live }` | owner | Live updates on or off. Viewers keep the last state. |
| `DELETE /api/shares/:id` | owner | Deletes the share and all its files. Viewers are told. |
| `GET /api/shares/:id/manifest` | anyone | `{ id, kind, title, entry?, live, seq, url, snapshotUrl?, files: [{ path, size, url }], createdAt, updatedAt }`, for "Open in mlch". |

Errors: 400 bad input, 401 not signed in or wrong server key, 402 no active subscription (mlch.app), 403 wrong token, 404 no such share, 409 not live / no snapshot yet, 411 no Content-Length, 413 too big, 429 too many new shares.

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

Accounts (mlch.app only):

| Request | Does |
|---|---|
| `GET /auth/google?challenge=<base64url sha256 of the app's verifier>` | Starts Google sign-in. Back at `/auth/google/callback`, a page opens `mlch://signed-in?code=<grant>` (one use, 10 minutes). |
| `POST /api/account/token` `{ code, verifier }` | `{ token }`: the session. |
| `GET /api/account` (Bearer session) | `{ email, name, subscription: { status, periodEnd } \| null, canShare }` |
| `POST /api/account/checkout` | `{ url }`: Stripe Checkout ($12/year, tax added), or the billing page when already subscribed. |
| `POST /api/account/portal` | `{ url }`: Stripe's billing page. |
| `POST /api/account/signout` | Ends the session. |
| `POST /api/stripe/webhook` | Stripe (signed): `customer.subscription.*` sets the account's status. `active` and `past_due` may make shares. |
| `GET /account/subscribed`, `/account/back` | Pages after Checkout and the billing page, with a link back to mlch (`mlch://account`). |

## Not done yet

- Expiry of old shares (they stay until deleted; a lapsed subscription keeps its links).
- Deleting an account.
- Reporting abuse; a rate limit on uploads beyond the per-share caps.
- Collaboration (several writers): the room already orders batches; it needs per-person origins, presence and edit locks (docs/PLAN-2.md M8).
