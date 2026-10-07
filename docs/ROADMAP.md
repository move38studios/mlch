# mlch roadmap

What we want to build or improve next, in priority order. One entry per item, with notes and a link to the research behind it. When something ships, delete it here (git history and docs/PLAN.md record what was built). Investigations go in `docs/research/`.

Order agreed 2026-10-07. The aim: first make mlch good for George to use every day, then make it something other people can install, then add the bigger new abilities.

## 1. Every day (George)

1. **Drag on empty canvas pans.** Today: two-finger scroll and middle or right drag pan; dragging on empty space draws a selection box. Make drag pan and Shift-drag select (Figma, Miro). Minutes.
2. **One input, no Thought / Instruction toggle.** Speech is already classified automatically (the capture lane hands instructions to the command lane); typed text in Thought goes through the same classification, so the toggle only forces an instruction. Drop it, show what was understood, keep a way to force an instruction (start with `/` or ⌘↩). Half a day.
3. **The AI moves the view.** It can already `focus` on items (moves to them and highlights them), so "show me the science part" mostly works. Missing: zoom out, fit everything, zoom in or out by a step. Add a view tool; simple ones ("zoom out") could run without waiting for the model. Half a day.
4. **Background work.** 2–3 days. The UX needs careful thought: it must be obvious that a long job (a deck, research) is alive and progressing, while the canvas stays fully usable (explore, speak, type, drop, give other instructions).
   - Today: four lanes per mulch run side by side on the server (capture, enrich, instructions, reading), so speaking during a deck already works and jobs survive going back to the list. Problems: every instruction shares one queue (a quick "summarize" waits behind a 10-minute deck); queued jobs are invisible; Stop stops everything; nothing says when a job finishes; quitting drops running and queued jobs silently.
   - Jobs become real things with a state (queued, working, done and not yet seen, failed), saved in the mulch folder.
   - Long jobs (make, research) each get their own slot, at most 2 per mulch and 3 overall; quick instructions get their own lane; capture and enrichment are never blocked.
   - On the canvas: one activity control instead of the row of pills; its list shows each job's name, time running, what it's doing now (for example "writing slide 4"), stop per job, done jobs linking to their new cards, failed jobs with the reason and Retry. Consider a placeholder card on the canvas where the result will land, showing progress, so the work is visible where it will appear.
   - On the list: a moving scribble while something works, an amber dot for unseen results, a red mark for failures.
   - A macOS notification when a long job finishes while you're elsewhere (click opens the mulch at the new cards); Dock badge for unseen results; new cards pulse when you come back.
   - Quitting with jobs running asks first; after a restart, interrupted jobs show as failed with Retry.
   - Later: a "needs you" state if the AI ever stops to ask something (herdr's "blocked").
   - References: herdr (agent states in a sidebar, work continues when you look away), Claude's desktop app (session list, unread dot, notifications). State names and notification text: wording from George.
5. **Design pass on the remaining screens.** Settings, side panel, search palette and the full-window artifact viewer use the new fonts and colours but haven't been designed. Write the design rules into CLAUDE.md at the same time: tokens, Schibsted Grotesk for the interface and the logo lettering only as the wordmark, scribbles in three places, ink outline for the person's own words, curved edges (solid for the person, dotted for the AI).
6. **PPTX and DOCX thumbnails.** Cards for decks and documents have no preview; use `nativeImage.createThumbnailFromPath` (Quick Look) in main. Half a day.
7. **Screenshots to the canvas.** A global shortcut opens macOS's window picker; the capture becomes an image card and gets enriched. No Screen Recording permission. About a day. [research](research/parakeet-and-calls.md#screenshots)

## 2. Other people can install it

8. **Packaged, signed app.** Bundle id `app.mlch.mac`, notarised, auto-update. Also shows "mlch" in the Dock (dev builds show "Electron").
9. **First run.** Needs: an AI (Claude Code or Codex installed and signed in, the hardest step for non-technical people), a Groq key (none once Parakeet is in), the microphone permission, the search model download (today it downloads on first use with no visible progress). One checklist screen that checks each item live and fixes what it can, then opens a new mulch with the mic ready. No tours or tips. Wording from George. 1–2 days.
10. **Local transcription with Parakeet.** Same speed as Groq on this Mac and the same accuracy; gains are offline, free, private, and no Groq key at first run. Swift helper using FluidAudio, Groq or local in Settings. 2–3 days. Needs working Command Line Tools or Xcode. [research](research/parakeet-and-calls.md#parakeet-versus-groq)

## 3. Bigger abilities

11. **Call mode.** Listen to Zoom or Teams (Core Audio process tap) plus the mic, speaker labels, batches every 30–60 s pulling out ideas, decisions and questions, clear indicator while listening, consent. Builds on the Parakeet helper and on background work. 1–2 weeks. [research](research/parakeet-and-calls.md#listening-to-calls)
12. **Connectors.** The person's own MCP servers, opt-in, read-only by default, approval cards for actions.
13. **Share snapshots.** A checkpoint plus its assets and a markdown index for AIs, hosted.

## Waiting for more testing

- **Headings and marks.** Headings (big free text naming an area of the canvas): probably yes. Marks the person puts on cards (important, decided, open) that the AI respects: maybe. Decorative stickers like briefbuster's: no, they fight the minimal look; the scribble is our one playful element.

## Maybe

- **Web version.** Needs hosted AI, since a subscription can't be used server-side.
- **Live collaboration.**

## Decided against for now

- **Re-titling a mulch once it has more on it.** Titles come from the first items and stay (2026-10-07).
