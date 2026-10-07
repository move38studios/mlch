# mlch roadmap

What we want to build or improve next, in priority order. One entry per item, with notes and a link to the research behind it. When something ships, delete it here (git history and docs/PLAN.md record what was built). Investigations go in `docs/research/`.

Order agreed 2026-10-07. The aim: first make mlch good for George to use every day, then make it something other people can install, then add the bigger new abilities.

## 1. Every day (George)

Shipped 2026-10-07: drag to pan, one input, the AI moves the view, typed notes as post-its, background work, design pass, deck and document previews, screenshots (⌘⇧2). Next, to discuss first:

1. **Home screen.** The full logo on the empty screen (centred, the scribbles and lettering), the small wordmark top-left once there is a list. The empty screen as one clear start (New, or straight into a new mulch with the mic ready, tied to First run). Whether mlch needs a tagline at all (in the app: probably not; on mlch.app: maybe). Wording from George.
2. **Connections between mulches.** Today each mulch is its own world; enrichment can already find and copy items from other mulches (`search_all_mulches`, `bring_in`). Options from light to heavy: links on cards that open another mulch at an item; a "related mulches" strip; backlinks; one shared graph of everything (Obsidian-like). To discuss.
3. **Empty mulches.** "Untitled, 0 items" rows pile up when New is pressed and nothing is added. Remove an empty untitled mulch when you leave it.
4. **Wording to confirm (George).** Placeholders now in the app: "Queued", "Stop", "Stop all", "Show", "Retry", "Dismiss", "Starting", "making", "research", "Stopped when mlch quit.", the quit question ("1 job is running." / "Quitting stops them. They can be retried later."), notifications (title = job name, text = mulch title or the error), "Add Screenshot".

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
