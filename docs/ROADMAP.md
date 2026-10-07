# mlch roadmap

What we want to build or improve next. One line per item, with notes and a link to the research behind it. When something ships, delete it here (git history and docs/PLAN.md record what was built). Investigations go in `docs/research/`.

## From testing, to prioritise (2026-10-07)

- **One input, no Thought / Instruction toggle.** Speech is already classified automatically (the capture lane hands instructions to the command lane); typed text in Thought goes through the same classification, so the toggle only forces an instruction. Drop it, show what was understood (an instruction shows as a job pill), keep a way to force it (start with `/` or ⌘↩). Half a day.
- **Drag on empty canvas pans.** Today: two-finger scroll and middle or right drag pan; dragging on empty space draws a selection box. Make drag pan and Shift-drag select (Figma, Miro). Minutes.
- **The AI moves the view.** It can already `focus` on items (moves to them and highlights them), so "show me the science part" mostly works. Missing: zoom out, fit everything, zoom in or out by a step. Add a view tool; simple ones ("zoom out") could run without waiting for the model. Half a day.
- **Labels and stickers?** briefbuster has decorative stickers (star, cat, poop…) and territory labels. Decorative stickers: no, they fight the minimal look; the scribble is our one playful element. Headings (big free text to name an area): probably yes. Marks the person puts on cards (important, decided, open) that the AI respects: maybe, after more testing.
- **First run.** Needs: an AI (Claude Code or Codex installed and signed in — the hardest step for non-technical people), a Groq key (none once Parakeet is in), the microphone permission, the search model download. Proposal: one checklist screen that checks each item live and fixes what it can, then opens a new mulch with the mic ready. No tours or tips. Wording from George. Belongs with the packaged app. 1–2 days.

## Next

- **Design pass on the remaining screens.** Settings, side panel, search palette and the full-window artifact viewer use the new fonts and colours but haven't been designed.
- **Design rules in CLAUDE.md.** Tokens, Schibsted Grotesk for the interface and the logo lettering only as the wordmark, scribbles used in three places, ink outline for the person's own words, curved edges (solid for the person, dotted for the AI).
- **Screenshots to the canvas.** A global shortcut opens macOS's window picker; the capture becomes an image card and gets enriched. No Screen Recording permission. About a day. [research](research/parakeet-and-calls.md#screenshots)
- **PPTX and DOCX thumbnails.** Cards for decks and documents have no preview; use `nativeImage.createThumbnailFromPath` (Quick Look) in main.
- **First-run download screen.** The search model (and later Parakeet) downloads on first use with no visible progress.

## Later

- **Local transcription with Parakeet.** Same speed as Groq on this Mac and the same accuracy; gains are offline, free, private. Swift helper using FluidAudio, Groq or local in Settings. 2–3 days. [research](research/parakeet-and-calls.md#parakeet-versus-groq)
- **Call mode.** Listen to Zoom or Teams (Core Audio process tap) plus the mic, speaker labels, batches every 30–60 s pulling out ideas, decisions and questions, clear indicator while listening. Builds on the Parakeet helper. 1–2 weeks. [research](research/parakeet-and-calls.md#listening-to-calls)
- **Packaged, signed app.** Bundle id `app.mlch.mac`, notarised, auto-update, for non-technical users. Also shows "mlch" in the Dock (dev builds show "Electron").
- **Connectors.** The person's own MCP servers, opt-in, read-only by default, approval cards for actions.
- **Share snapshots.** A checkpoint plus its assets and a markdown index for AIs, hosted.

## Maybe

- **Web version.** Needs hosted AI, since a subscription can't be used server-side.
- **Live collaboration.**

## Decided against for now

- **Re-titling a mulch once it has more on it.** Titles come from the first items and stay (2026-10-07).
