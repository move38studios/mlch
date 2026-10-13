# mlch roadmap

What we want to build or improve next, in priority order. One entry per item, with notes and a link to the research behind it. When something ships, delete it here (git history and docs/PLAN.md record what was built). Investigations go in `docs/research/`.

Order agreed 2026-10-12: **docs/PLAN-2.md**, from a call to a shared link (links and sources, local transcription, call mode, menu bar, sharing, onboarding, signed release, then collaboration). Its milestones and checks are the work list; this file keeps what is outside it.

## To decide (George)

- **Share server for an open-source mlch.** Proposal (2026-10-13): open-source the app and `cloud/`; Settings → Sharing → Server: mlch.app (hosted, with limits and expiry of unopened shares) or your own (a "Deploy to Cloudflare" template of cloud/, address pasted in). Same documented protocol, links carry their server, collaboration follows. No Cloudflare credentials in the app. Licence: George's call (e.g. MIT app, AGPL server).
- **Including linked items in a share.** Today link cards are shared as titles only. Proposal: the Share menu counts them and offers "Include what they link to" (a copy of each linked item at that moment).

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
