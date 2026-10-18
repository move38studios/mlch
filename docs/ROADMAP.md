# mlch roadmap

What we want to build or improve next, in priority order. One entry per item, with notes and a link to the research behind it. When something ships, delete it here (git history and docs/PLAN.md record what was built). Investigations go in `docs/research/`.

Order agreed 2026-10-13: **docs/PLAN-3.md**, a small public release (fixes from testing, the AI as a thinking partner, decks and pages, home search, menus, open source and updates, mlch.app with a landing canvas, admin, friend codes and live payments). Then collaboration (PLAN-2 M8). The plans' milestones and checks are the work list; this file keeps what is outside them.

## Where things stand (2026-10-13)

- 0.2.1 is released (docs/PLAN-3.md, Status). George is doing a fresh install from mlch.app; his previous data is in `~/mlch-before-reinstall-20261013-2/` (and the older `~/mlch-before-reinstall-20261013/`).

## Outside the plans

1. **Everything the AI writes reads cold.** Seen 2026-10-18 on the Loudbox canvas: the competitive landscape deck opens with "31 companies profiled from DCBL's tracked universe of 40" and "How many of the 31 cover each step"; the territories page leans on "George's three post-its", "DCBL's market update v4.3", "the ICP", "Vadim raised this", "the 200–250 companies in the CRM". George: "imagine someone just opening this deck with 0 context." Well-written things assume zero context: the reader has not seen the canvas, the conversation, the sources or the call.
   - Why it happens: no default prompt says who the reader is. The writer has the whole canvas in its prompt and writes from inside it. Deck content drafted by an instruction (write_doc) went to the maker with "use its wording verbatim", so the inside wording reached the slides and no one read it fresh.
   - The fix, in the default prompts (BASE, COMMAND, MAKER, RESEARCH; editable in Settings) and the tools:
     - The rule: write for someone who opens the file with no context. The title says what it is; the opening says the subject (what Loudbox is), for whom, when, and where the facts come from; every name, acronym, number and reference ("the 31", "the call", "DCBL", "the ICP", a person) is explained where it first appears, or cut. No canvas internals (item ids, "on the canvas", "the write-up").
     - A cold reader pass: after a deck, page or document is written, a fresh model call that sees only the file's text (no canvas, no brief) lists what a newcomer could not follow; the writer fixes it and checks again. A fresh reader, because the writer cannot unknow what it knows. For HTML in `preview_artifact` (which already checks every slide), and for write_doc and the maker's files.
     - Briefs to the maker say who the reader is and never pass canvas-internal wording as "verbatim".
     - Make only the formats asked for (the same deck came with an unrequested PDF).
   - Check: rerun the Loudbox deck and territories page from the same canvas and read them cold.
2. **Reading videos (and other context) properly.** On the Loudbox canvas the AI could not read two local mp4s: "0 frames", "5 seconds". Cause: `media/inspect.ts` calls `ffprobe`/`ffmpeg` by name, and the packaged app's server has no shell PATH (Finder gives apps none), so Homebrew's are not found; the probe fails silently, the length falls back to 5 s, no frames come out. Even with frames, a video's soundtrack is never transcribed. Then the maker job that was to do it by hand failed three times on the old 40-step limit (gone in 0.2.6).
   - The app's PATH: at launch, take the PATH of the person's login shell (as Terminal has it), so mlch, its server and the Claude Code / Codex it runs find what the terminal finds (ffmpeg, uv, node, git). Today they get macOS's bare default.
   - Gemini first when there is a key: it watches and listens in one go (pictures, speech, music, on-screen text), as `media/gemini.ts` already does for YouTube. Without a key, locally: the native helper (`native/mlch-audio`) takes frames with AVFoundation (at scene changes and every few seconds) and pulls the soundtrack, which goes to the transcriber the person chose (Parakeet on this Mac, or Groq). ffmpeg only as a fallback. The AI can also ask for the other path (frames for a closer look at one moment).
   - Graceful in every case, each saying what was and wasn't read: no Gemini key; Gemini refuses, times out, is over quota or the file is too long or big (fall back to local); Groq chosen (its upload size limit: send the soundtrack in pieces); Parakeet's model not downloaded yet (download it, or frames only); no soundtrack, or music only; a format AVFoundation can't open (webm, mkv: ffmpeg if found, else Gemini, else say so); a very long video (a frame budget, the transcript in full); a file in iCloud or Google Drive not downloaded yet; a video that is a link (YouTube, Vimeo, a file link).
   - Sending a video to Gemini sends it to Google: README's "What leaves the Mac" says so.
   - Prompts: when something can't be read one way, try the others before saying so, and say plainly what was and wasn't read.
3. **Website screenshots that arrive.** The Loudbox deck has no screenshots although they were asked for: every company slide has the space and nothing in it. The instruction wrote the maker a brief to take 21 fresh screenshots with Playwright, but the maker's sandbox reaches only package registries, so none could be taken; the 10 already on the canvas were named by item id, which the maker cannot turn into files; and the report of what failed never reached the person. Separately, the screenshots on the canvas are all called `file.png`: they come from a screenshot service whose address has no file name (`tools.ts` add_file falls back to "file").
   - A screenshot tool of our own (main renders the page in a hidden window, as `preview_artifact` does), for instructions and research: real file names (the site's host), cookie banners dismissed where possible.
   - Briefs to the maker name canvas files by path, not item id; the maker prompt says what it cannot reach, so instructions don't ask it to.
   - What a job could not do reaches the person (a message on the job), never only a report inside its turn.
   - add_file names a file from its caption or the page's host when the address has no name.
4. **The AI works like the person's own Claude Code or Codex, in auto mode.** Agreed 2026-10-18. Today instructions have no shell at all (only mlch's tools and web search), and the maker has a shell sandboxed to the mulch's folders with network only to package registries; that is why the Loudbox screenshots and the video work failed. mlch's idea is a more visual interface on the person's real Claude Code or Codex, so it should be able to do what theirs can.
   - Instructions, research and the maker get the CLI's real tools (shell, files, network), in **auto mode** by default: Claude Code's `permissionMode: "auto"` (a classifier approves or denies each action; what it cannot decide comes to the person as an Allow / Deny card, the cards connectors already use, and only that job waits); Codex's `approvals_reviewer = "auto_review"` (the maker's `codex exec` cannot ask: what auto review refuses is refused and reported). Where auto mode is unavailable on the person's plan: their own permission rules, everything else as cards.
   - The person's own permission rules (settings.json allow / deny) apply on top.
   - Settings → AI: Auto (default), Ask me (cards for anything not allowed), Sandboxed (today's behaviour).
   - Capture and enrichment stay as they are (mlch's tools only): they run on everything said, including the other side of a call.
   - CLAUDE.md's rule "never give the agent an unsandboxed shell" becomes: the agent runs as the person's own CLI does, in auto mode unless they chose otherwise.
   - With it: the PATH from the login shell (item 2), so the tools the terminal has are there.
5. **Comments on what the AI made.** George keeps reaching to comment on a card or a made file. A comment is an instruction about that thing (the `about` of selected cards, built 2026-10-18), typed where the thing is:
   - On a card: a small comment control when it is selected or hovered (and ⌥ held with it selected, spoken). On a made file in the viewer: click a slide, an element or selected text; the comment carries where (slide 4, the passage).
   - It acts at once, like any instruction; comments on the same file wait for each other so edits don't collide; others run side by side.
   - A made file remembers the session that made it, and a comment on it resumes that session, so "fix slide 2" changes the same file with the reasoning that built it.
   - The thread stays with the thing: a small mark on the card or slide with its comments and what came of each (the reply, what changed), from the jobs that were about it. No new kind of record.
   - Later, with collaboration: the same comments from people on a shared link.
   - To decide: the wording (George), and whether comments can also be collected and sent together ("apply all").
6. **Share a call's transcript or notes on their own.** Each call has a transcript card (speech only, Me and Them with times; typed and ⌥ instructions are not in it) and a notes card, both write-ups with a file in `docs/`. There is no way to share or copy one without sharing the whole canvas. Give write-ups (transcripts and notes included) the Share that made files have (a link to a clean read-only page) and Copy as text.
7. **Home screen.** The full logo on the empty screen (centred, the scribbles and lettering), the small wordmark top-left once there is a list. The empty screen as one clear start (New, or straight into a new mulch with the mic ready, tied to onboarding). Whether mlch needs a tagline at all (in the app: probably not; on mlch.app: maybe). Wording from George.
8. **Your Claude Code and Codex setup: what's left.** Built 2026-10-15 (docs/research/connectors.md). Still to do: ChatGPT apps in Codex, the person's setup in Codex making turns (`codex exec`), a Dock badge while a connector card waits.
9. **Settings → AI stuck on "Preparing Claude Code" after launch.** Opening Settings soon after launch can show it in red forever; switching to Codex and back shows the right state. A race between the CLI check at launch and the panel's status. (Noted 2026-10-15.)

## From testing (George, 2026-10-18, on the MLCH dev board)

- **Selecting many cards or an area to delete.** "No way to select multiple / full area on the canvas to delete." Today: shift-drag draws a selection box and ⌘-click adds cards (React Flow's defaults), but nothing shows that; dragging the empty canvas pans.
- **Markdown on post-its.** "Markdown (bold etc) not rendered on a postit, but rendered in the detailed postit editor (side)." Notes render as plain text on the canvas (`kinds.ts`: no `markdown` for `note`); the side panel renders markdown.

## When the problem shows up

- **Mulches from a newer mlch in an older build.** Official builds, forks and builds from source can open the same library. If a release changes the mulch format (always with a migration), an older build or a fork may misread a migrated mulch. Then: write the format version in each mulch and open a newer one read-only in an older build, saying it was saved by a newer mlch. (Noted 2026-10-14.)
- **Forks and mlch.app sharing.** Forks share through mlch.app unless they set their own server. The Worker accepts older app versions and can answer "Update mlch to keep sharing". If forks start breaking shares (other ops, other formats), require a version or build header and refuse unknown ones with a plain message. (Noted 2026-10-14.)

## Waiting for more testing

- **Marks.** Headings (areas of the canvas) moved into plan 2 (M3). Marks the person puts on cards (important, decided, open) that the AI respects: maybe. Decorative stickers like briefbuster's: no, they fight the minimal look; the scribble is our one playful element.

## Maybe

- **Web version.** Needs hosted AI, since a subscription can't be used server-side.

## Decided against for now

- **Re-titling a mulch once it has more on it.** Titles come from the first items and stay (2026-10-07).
