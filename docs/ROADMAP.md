# mlch roadmap

What we want to build or improve next, in priority order. One entry per item, with notes and a link to the research behind it. When something ships, delete it here (git history and docs/PLAN.md record what was built). Investigations go in `docs/research/`.

Order agreed 2026-10-13: **docs/PLAN-3.md**, a small public release (fixes from testing, the AI as a thinking partner, decks and pages, home search, menus, open source and updates, mlch.app with a landing canvas, admin, friend codes and live payments). Then collaboration (PLAN-2 M8). The plans' milestones and checks are the work list; this file keeps what is outside them.

## Where things stand (2026-10-13)

- Everything up to and including sharing accounts is committed on main; `npm run check` and the scenarios pass. mlch.app runs the accounts Worker (Stripe test mode, Google sign-in in testing mode).
- `dist/mlch-0.1.0-arm64.dmg` (signed, sharing choices included) is installed and was tested by George on 2026-10-13: Google sign-in and a test subscription worked; what came up is PLAN-3.
- For a clean first run, this Mac's mlch data was moved to `~/mlch-before-reinstall-20261013/` (`library` was ~/Documents/mlch with 4 mulches, `app-support` was ~/Library/Application Support/mlch with saved keys, models and CLIs, `logs`, the preferences plist). Put `library` back to get the old mulches; delete the folder when no longer needed.
- Open: roll the Stripe test-mode secret key (shown in a session transcript); PLAN-3 R7.
- If sharing fails with "The sharing server could not be reached.", desktop.log / mulch.jsonl now have the cause (it used to hide other errors).

## Outside the plans

1. **Home screen.** The full logo on the empty screen (centred, the scribbles and lettering), the small wordmark top-left once there is a list. The empty screen as one clear start (New, or straight into a new mulch with the mic ready, tied to onboarding). Whether mlch needs a tagline at all (in the app: probably not; on mlch.app: maybe). Wording from George.
2. **Connectors.** The person's own MCP servers, opt-in, read-only by default, approval cards for actions. Today the harness turns them off on purpose (`settingSources: []`; Codex MCP servers disabled).

## Waiting for more testing

- **Marks.** Headings (areas of the canvas) moved into plan 2 (M3). Marks the person puts on cards (important, decided, open) that the AI respects: maybe. Decorative stickers like briefbuster's: no, they fight the minimal look; the scribble is our one playful element.

## Maybe

- **Web version.** Needs hosted AI, since a subscription can't be used server-side.

## Decided against for now

- **Re-titling a mulch once it has more on it.** Titles come from the first items and stay (2026-10-07).
