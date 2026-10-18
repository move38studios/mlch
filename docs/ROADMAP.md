# mlch roadmap

What we want to build or improve next, in priority order. One entry per item, with notes and a link to the research behind it. When something ships, delete it here (git history and docs/PLAN.md record what was built). Investigations go in `docs/research/`.

Order agreed 2026-10-13: **docs/PLAN-3.md**, a small public release (fixes from testing, the AI as a thinking partner, decks and pages, home search, menus, open source and updates, mlch.app with a landing canvas, admin, friend codes and live payments). Then collaboration (PLAN-2 M8). The plans' milestones and checks are the work list; this file keeps what is outside them.

## Where things stand (2026-10-19)

- 0.3.0 is on the beta channel (George's Mac follows beta). Built overnight 2026-10-18/19 from the Loudbox canvas and the MLCH dev board: the AI as the person's own CLI in auto mode, everything written reads cold, videos read, website screenshots, comments with Live / Quiet, sharing write-ups, link previews, the deck slide bar, selecting an area. Latest is 0.2.5 until George promotes.

## Outside the plans

1. **Home screen.** The full logo on the empty screen (centred, the scribbles and lettering), the small wordmark top-left once there is a list. The empty screen as one clear start (New, or straight into a new mulch with the mic ready, tied to onboarding). Whether mlch needs a tagline at all (in the app: probably not; on mlch.app: maybe). Wording from George.
2. **Codex as fully as Claude Code.** Codex instructions have no shell: its app-server runs locked down for the whole process (`CODEX_LOCKDOWN_CONFIG`), so auto mode would need a second, unlocked app-server for the person's work (sandbox and `approvals_reviewer = "auto_review"` per thread). Also: the person's setup (config, AGENTS.md) in Codex making turns (`codex exec` runs with `--ignore-user-config`), and ChatGPT apps in Codex (docs/research/connectors.md).
3. **Comments on a page's words.** Comments carry a deck's slide; a page or document can't yet take a comment on selected words (the viewer's frame is sandboxed: the page would have to report the selection, as the deck player reports its slide). Decks the maker wrote with its own script (like the first Loudbox deck) keep their own navigation and have no slide bar; mlch's own decks, old ones too, have it.
4. **Link previews for shared write-ups.** A write-up shared on its own has no preview picture in chats (main renders only artifacts/ for previews).

## When the problem shows up

- **Mulches from a newer mlch in an older build.** Official builds, forks and builds from source can open the same library. If a release changes the mulch format (always with a migration), an older build or a fork may misread a migrated mulch. Then: write the format version in each mulch and open a newer one read-only in an older build, saying it was saved by a newer mlch. (Noted 2026-10-14.)
- **Forks and mlch.app sharing.** Forks share through mlch.app unless they set their own server. The Worker accepts older app versions and can answer "Update mlch to keep sharing". If forks start breaking shares (other ops, other formats), require a version or build header and refuse unknown ones with a plain message. (Noted 2026-10-14.)

## Waiting for more testing

- **Marks.** Headings (areas of the canvas) moved into plan 2 (M3). Marks the person puts on cards (important, decided, open) that the AI respects: maybe. Decorative stickers like briefbuster's: no, they fight the minimal look; the scribble is our one playful element.

## Maybe

- **Web version.** Needs hosted AI, since a subscription can't be used server-side.

## Decided against for now

- **Re-titling a mulch once it has more on it.** Titles come from the first items and stay (2026-10-07).
