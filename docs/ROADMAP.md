# mlch roadmap

What we want to build or improve next, in priority order. One entry per item, with notes and a link to the research behind it. When something ships, delete it here (git history and docs/PLAN.md record what was built). Investigations go in `docs/research/`.

Order agreed 2026-10-12: **docs/PLAN-2.md**, from a call to a shared link (links and sources, local transcription, call mode, menu bar, sharing, onboarding, signed release, then collaboration). Its milestones and checks are the work list; this file keeps what is outside it.

## Outside plan 2

1. **Home screen.** The full logo on the empty screen (centred, the scribbles and lettering), the small wordmark top-left once there is a list. The empty screen as one clear start (New, or straight into a new mulch with the mic ready, tied to onboarding). Whether mlch needs a tagline at all (in the app: probably not; on mlch.app: maybe). Wording from George.
2. **Real landing page on mlch.app.** Plan 2 puts up a placeholder (the wordmark only). Wording and design from George.
3. **Shares when a mulch goes away (open question, George 2026-10-12).** What happens to its share links when a mulch is deleted, and later to shared canvases others collaborate on. George's idea: no deletes, only archiving; turning off links (single made files or whole canvases) stays manual, with an option on archiving to turn off all of that mulch's links. Today deleting moves the mulch to the library's .trash folder with its owner tokens (shares.json); its links stay live and can no longer be stopped from the app.
4. **Shared pages: titles and link previews.** Tab icon and the canvas title are in. Open Graph tags (title, description, a preview image of the canvas or the made file's first page) so links unfurl in Slack, iMessage and email; the Worker would add them to the page it serves.
5. **Images, audio, video and links to them dropped on the canvas.** What each becomes (a card that shows or plays it, a transcript for audio and video, a caption for images, what the AI may do with it). Look first at how ~/dev/briefbuster handles them (George, 2026-10-12).
6. **Connectors.** The person's own MCP servers, opt-in, read-only by default, approval cards for actions. Today the harness turns them off on purpose (`settingSources: []`; Codex MCP servers disabled).

## Waiting for more testing

- **Marks.** Headings (areas of the canvas) moved into plan 2 (M3). Marks the person puts on cards (important, decided, open) that the AI respects: maybe. Decorative stickers like briefbuster's: no, they fight the minimal look; the scribble is our one playful element.

## Maybe

- **Web version.** Needs hosted AI, since a subscription can't be used server-side.

## Decided against for now

- **Re-titling a mulch once it has more on it.** Titles come from the first items and stay (2026-10-07).
