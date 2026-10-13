# mlch roadmap

What we want to build or improve next, in priority order. One entry per item, with notes and a link to the research behind it. When something ships, delete it here (git history and docs/PLAN.md record what was built). Investigations go in `docs/research/`.

Order agreed 2026-10-12: **docs/PLAN-2.md**, from a call to a shared link (links and sources, local transcription, call mode, menu bar, sharing, onboarding, signed release, then collaboration). Its milestones and checks are the work list; this file keeps what is outside it.

## Before sharing on mlch.app goes live (George)

Built 2026-10-13: the three sharing choices, Google sign-in, $12/year subscription (Stripe test mode), own servers. What's left needs George:

- **Legal pages on mlch.app:** privacy policy, terms, refund policy, company details. Drafts to rewrite: `docs/drafts/`. Google needs the privacy and terms links before the sign-in screen can be published (Google Auth Platform → Branding, then Audience → Publish app); until then only test users can sign in (george@m38.ai). Stripe needs them for live payments.
- **Stripe live mode:** a restricted live key (Customers, Checkout Sessions, Subscriptions, Billing portal, Prices: write) as the Worker secret `STRIPE_SECRET_KEY` (`npx wrangler secret put STRIPE_SECRET_KEY -c wrangler.mlch.jsonc` in cloud/), the live product and price (lookup key `mlch_sharing_yearly`, $12/year USD, tax exclusive), a live webhook to `https://mlch.app/api/stripe/webhook` (customer.subscription.*) as `STRIPE_WEBHOOK_SECRET`, tax registrations in live mode (EU one-stop VAT scheme: accountant). Test mode now uses the Stripe CLI's key, which expires 2027-01-11.
- **Publishing the source:** the own-server guide (mlch.app/server) says "the mlch source code" without a link until the repo is public. A "Deploy to Cloudflare" button needs cloud/ to build on its own (the viewer builds from the app's components today).
- **Deleting an account** (privacy): not built. Sessions can be signed out; account rows stay.
- **Licence:** George's call (e.g. MIT app, AGPL server).

## Outside plan 2

1. **Home screen.** The full logo on the empty screen (centred, the scribbles and lettering), the small wordmark top-left once there is a list. The empty screen as one clear start (New, or straight into a new mulch with the mic ready, tied to onboarding). Whether mlch needs a tagline at all (in the app: probably not; on mlch.app: maybe). Wording from George.
2. **Real landing page on mlch.app.** Plan 2 puts up a placeholder (the wordmark only). Wording and design from George.
3. **Connectors.** The person's own MCP servers, opt-in, read-only by default, approval cards for actions. Today the harness turns them off on purpose (`settingSources: []`; Codex MCP servers disabled).

## Waiting for more testing

- **Marks.** Headings (areas of the canvas) moved into plan 2 (M3). Marks the person puts on cards (important, decided, open) that the AI respects: maybe. Decorative stickers like briefbuster's: no, they fight the minimal look; the scribble is our one playful element.

## Maybe

- **Web version.** Needs hosted AI, since a subscription can't be used server-side.

## Decided against for now

- **Re-titling a mulch once it has more on it.** Titles come from the first items and stay (2026-10-07).
