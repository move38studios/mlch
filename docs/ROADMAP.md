# mlch roadmap

What we want to build or improve next. One line per item, with notes and a link to the research behind it. When something ships, delete it here (git history and docs/PLAN.md record what was built). Investigations go in `docs/research/`.

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
