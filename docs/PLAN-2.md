# mlch plan 2: from a call to a shared link

Written 2026-10-12, for George to review before work starts. V1 (built) is docs/PLAN.md; once this plan is agreed, docs/ROADMAP.md is rewritten to follow it.

## Status (2026-10-12)

Built and checked in the app: M0, M1, M2, M3 (system audio unverified), M4, M5 (against a local Worker), M6, M7 up to an unsigned package. Open:
- **Deployed 2026-10-12:** mlch.app (placeholder), www → apex, share.mlch.app, the sharing API and R2 bucket `mlch-shares` (move38 account). Redeploy: `cd cloud && CLOUDFLARE_ACCOUNT_ID=a7b1e373a9581b6f04e2a48d3abc9aa3 npm run deploy`.
- **System audio (G6):** grant "System Audio Recording" to mlch (dev: the terminal or Electron), then `node scripts/electron-run.cjs scripts/scenarios/local-audio.cjs` and a real call.
- **Signing and notarizing (G2):** `npm run dist` signs with the move38 Developer ID (macOS may ask once for keychain access to the key); notarizing needs `xcrun notarytool store-credentials mlch` and `APPLE_KEYCHAIN_PROFILE=mlch`. Releases: `node scripts/release.mjs` after the deploy.
- **Distribution terms (G4)** before anyone else installs it.
- **Wording (G5):** the list at the end.
- Not built: areas and headings during a call; collaboration (M8).

## The goal

The use case that makes mlch worth giving to friends:

1. In a call, click the mlch icon in the menu bar and start a new mulch.
2. The mulch builds up as the call goes on. It hears both sides (me and them) and enriches with the web and with my earlier mulches and notes. It organizes as it goes.
3. During the call I steer by typing ("from what we just discussed, build a quick deck").
4. During or right after the call I send a link to the deck, or to the whole canvas. People with the link can view it read-only or copy it into their own mlch. Later, with a collaboration link, they can join it and add to it.

Released when 1–4 work, apart from joining (collaboration), which follows the release (M8).

## Order

| | Milestone | Why here |
|---|---|---|
| M0 | Housekeeping and gestures | Daily irritations; commit work in progress |
| M1 | Knowledge layer: links and sources | Needs no native toolchain; fixes the reference format before sharing depends on it |
| M2 | Native helper and local transcription (Parakeet) | Base for call mode; needs Xcode (G1) |
| M3 | Call mode | The core of the goal |
| M4 | Menu bar and staying open | Step 1 of the goal; small once M3 exists |
| M5 | Sharing: deck links, canvas links, copy into your own mlch | Step 4 of the goal; first hosted code |
| M6 | Onboarding | Others can set it up |
| M7 | Packaged, signed, auto-updating release | Friends can install it |
| M8 | Collaboration | After the release |

Each milestone ends with its checks passing.

## Needs George (blocking items marked)

- **G1 (resolved 2026-10-12).** The Command Line Tools' Swift can't build against its own SDK. Worked around without admin rights: the swift.org 6.1.2 toolchain installed for this user (`~/Library/Developer/Toolchains`), building against the CLT's macOS 15.2 SDK. Installing Xcode would still be the cleaner fix.
- **G2 (blocks M7).** Notarization credentials for the move38 B.V. Developer ID (found in the keychain: `Developer ID Application: move38 B.V. (FP3X7G6BU7)`). One-time: `xcrun notarytool store-credentials mlch` with an app-specific password or an API key.
- **G3 (blocks M5 deploy).** mlch.app is in the Cloudflare "move38 account". Deploying (Worker, R2, Durable Object, the placeholder landing) was approved by George but is blocked by Claude Code's auto-mode guard; George runs the deploy command or allows it. Whether shared HTML is served from a separate domain (safer; something like `mlch.page`, to buy) or `share.mlch.app` (sandboxed, see M5).
- **G4 (before M7).** Distribution terms: whether a third-party app may drive a person's Claude Code / Codex subscription (open item in PLAN.md). Your call or Anthropic's, not mine.
- **G5 (any time).** Wording. I use bare placeholders and collect every new string in "Wording" at the end of this file. Nothing customer-facing ships beyond placeholders until you have gone through that list.
- **G6 (M3, M7).** Tests only you can do: a real call (Zoom or Meet, headphones and speakers), and installing the release on a second Mac.
- **Permission prompts.** M3 triggers macOS's "System Audio Recording" prompt and M2 a model download (about 600 MB); I'll ask before the first one.

## How I work through it

- One milestone at a time, in order. Within it, one step per commit, `npm run check` green before each commit. No pushing to a remote, deploying or uploading except the steps listed here as outward-facing (M5 deploy, M7 notarization), and those only after G3/G2.
- Every step has checks: unit tests (vitest), app scenarios driven with `scripts/electron-run.cjs` (fake mic, throwaway library), screenshots looked at, and where only a person can judge, a line under "George checks".
- If a step turns out bigger or different than written, I note it in this file (a short "Changed:" line) and carry on if it doesn't change the goal; I stop and ask if it does.
- When blocked on a G item, I skip to the next step that isn't blocked.
- docs/ROADMAP.md loses each item as it ships; CLAUDE.md gains a line per new subsystem (helper, sources, sharing).

---

## M0. Housekeeping and gestures

1. **Prompt editing (in the working tree, uncommitted).** Review, test that an edited prompt is used on the next turn and that reset restores the default, commit.
   - Check: unit test for prompt assembly with and without overrides; scenario: edit Capture, speak, the job log shows the edited prompt.
2. **Canvas gestures.** Mouse wheel zooms at the pointer; trackpad two-finger scroll pans, pinch zooms; ⌘/Ctrl-wheel zooms for both; Space-drag pans; ⌘+ / ⌘− / ⌘0 (fit). Tell wheel from trackpad by delta pattern (line mode or large integer steps with no x movement = wheel).
   - Check: unit tests for the classifier on recorded event sequences (wheel, trackpad pan, pinch); scenario dispatches synthetic wheel events and asserts zoom versus pan.
   - George checks: feels right with a real mouse and the trackpad.
3. **Empty mulches.** An untitled mulch with no items is removed when you leave it.
   - Check: scenario: New, go back, the list has no empty row; a mulch with one item stays.
4. **Roadmap rewrite** to follow this plan.

## M1. Knowledge layer: links and sources

### Links instead of copies (the UX)

The AI puts links on the canvas by itself, but a link is not a copy:

- **Link card.** Small card, hairline, with a chip naming where it lives ("Pricing ideas", or the vault name for a note) and the date. Shows the target's title and the first lines of its text, **read live from the target** (nothing copied). Placed near the idea it relates to, joined by the AI's dotted connection whose label says *why* they connect. That label is the value; no reason, no link.
- **Click: peek, don't leave.** A side panel shows the target item with its neighbours in its own mulch (or the note's text). "Open" goes there. Peeking matters in a call: you can't jump away.
- **Promote.** "Bring here" turns a link into a real card on this canvas (today's `bring_in`), when you want to work with it.
- **Backlinks.** The target mulch knows it is linked to ("Linked from" on the item and in the mulch's menu).
- **Gone targets.** If the target is removed, the card says so, faded. Deleting a link card removes only the link.
- **Volume.** At most 1–2 per batch, never a target already linked from this mulch, never on mere topic-word overlap. Tunable in Settings (the existing "mulches" enrichment switch becomes "links": off / some / more).

### Steps

1. **Data.** New node kind `link` with `ref: { mulchId, itemId } | { sourceId, path, anchor? }`, an op like any other (logged, undoable, history). No text copied into the node. Search index skips link cards (no duplicates in search). `ref` ids are stable and contain no local paths, so they survive sharing (M5) and collaboration (M8).
   - Check: ops round-trip and undo tests; describeMulch shows link cards with the target's live title for the agent.
2. **Link card, peek panel, backlinks, "Bring here".**
   - Check: scenario with two mulches: link appears, peek shows the target, Open lands on the target with focus, backlink listed, Bring here makes a real card, deleting the target fades the card. Screenshots reviewed against the design rules.
3. **Agent tools.** `link_to` (replaces proactive `bring_in` use), `read_source` works on any mulch item or source file, search results say where they come from (this mulch / other mulch / source).
   - Check: tool unit tests, including the error text saying what is allowed.
4. **Sources: folders linked once, for every mulch.** Settings → Sources: add a folder, read-only. Indexed into the library index incrementally (watch for changes, re-index changed files only), with visible progress. Each source: "use without asking" or "only when asked". Respect the private-folder refusals in files.ts.
   - Check: index a generated 2,000-file fixture vault; time it; the app stays responsive; editing a file re-indexes just that file; removing the source removes its entries.
5. **Obsidian.** Detect a vault (`.obsidian/`). Read `[[wikilinks]]`, tags and frontmatter, so search hits carry the note's links and the agent can follow them. Link cards on notes open in Obsidian (`obsidian://open`). Per vault, off by default: "mlch can add notes here" (into a folder you choose, e.g. `mlch/`); when on, write-ups can be saved there. mlch never edits existing notes.
   - Check: fixture vault with links and frontmatter; a search hit lists the note's links; write-back creates a new file only in the chosen folder and refuses anything else.
6. **Prompts use it.** Enrichment: search this mulch, other mulches and sources; link when there's a real connection. Research and making files: look at your mulches and sources first, cite them as link cards. Instructions: fall back to other mulches and sources when this one has nothing.
   - Check: scenario with seeded mulches and a fixture vault: speaking about a topic covered in the vault produces one link card with a reasoned label; an unrelated topic produces none. Run 5 times; record hit and false-link counts here.
   - Changed: the model rarely searched on its own (first run: no search, no link), so enrichment and research now get the best hits from other mulches and auto sources in the prompt (`<elsewhere>`, found in code) and the model only judges and links. Result 2026-10-12 (`scripts/scenarios/proactive-links.cjs`): related thought → 2 links ("contradicts: per-seat, not per-minute", "March decision against metering"); unrelated → 0.
   - George checks: a week of real use with your vault (needs your vault path; Obsidian isn't installed on this Mac).

## M2. Native helper and local transcription

1. **Helper `mlch-audio`.** Swift package in `native/mlch-audio`, a single binary started by main, JSON lines over stdio, outside Electron's processes. Built by a script, signed with the app. Commands to start with: `transcribe` (a WAV chunk), `status`, `download-model`.
   - Check: helper unit tests (Swift), and a node test that starts it, sends a chunk, gets text, kills it cleanly; helper crash is logged and restarted once.
2. **Parakeet via FluidAudio** behind the existing `Transcriber` interface. Model downloads on demand with progress; kept in `~/Library/Application Support/mlch/models`.
   - Check: the two clips from the research transcribe with the same quality as Groq (word overlap ≥ 95%), warm latency under 0.5 s; scenario with `--fake-mic` runs end to end on local.
3. **Settings: Groq or local**, choice remembered; Groq still works when there's no model.
   - Check: switching mid-session uses the new one for the next chunk.

## M3. Call mode

1. **System audio.** Core Audio process tap in the helper (macOS 14.4+): all output, or one app (Zoom, Teams, a browser). Streams 16 kHz mono chunks cut at pauses like the mic. Permission "System Audio Recording Only".
   - Check: helper test taps `afplay` playing a known WAV and gets matching audio; permission denied is reported as a clear state, not a hang.
2. **Two streams, two speakers.** Mic = me, system audio = them. On speakers, drop mic segments that repeat what system audio carried in the same seconds (start simple; echo removal only if this isn't enough). Transcript segments carry `speaker: me | them`; origins `speech:` as today.
   - Check: scenario plays a two-voice WAV through system audio while the fake mic plays the other side; transcript labels match on ≥ 90% of segments; on a speakers recording, no duplicate segments.
3. **Call lane.** A capture prompt for conversations: batches every 30–60 s, pulls out ideas, decisions, open questions and action items, with who said them; enrichment as usual (web, links, sources); arranging into areas as the canvas grows (canvas areas and headings, promoted from "Waiting for testing").
   - Check: replay a recorded 20-minute two-person call (I'll make one from two voices, or use one you provide): cards keep up within a batch; decisions and questions are labelled; nothing the person typed is moved. Subscription use for an hour of call measured and written here.
4. **Steering during the call.** Typed instructions run alongside capture without pausing it. "Make a quick deck" from the call so far: the maker/command lane gets the call transcript, not just the cards. A quick deck is an HTML artifact (fast); a .pptx stays a long job.
   - Check: during the replay, an instruction produces a deck artifact card in under 2 minutes while capture continues.
5. **Listening indicator and controls.** Always visible while listening (window and menu bar), stop at any time, never starts by itself. Consent line: wording from you (G5).
   - George checks: a real call, headphones and speakers.
   - Result 2026-10-12 (`scripts/scenarios/call.cjs`, a generated two-voice call through the mic, local Parakeet, real AI): first cards 51 s after the call started (30 s batches), a quick deck from "from what we just discussed, build a quick deck" 20 s after asking, while listening; decisions, to-dos and questions captured. System audio could not be checked here: macOS has not granted "System Audio Recording" (see local-audio.cjs). Areas and headings during a call: not built yet (arrange would move the person's spoken cards, which the AI may not do).

## M4. Menu bar and staying open

1. **Menu bar icon** (the scribble mark): New, New call, open recent, the current listening state. Closing the window keeps mlch running in the menu bar; Quit still asks while work runs.
2. **Global shortcut** for New call (default to be agreed; screenshot keeps ⌘⇧2).
3. **Open at login** (off by default, in Settings).
   - Check: scenario: close window, app still running, menu bar New call opens a mulch listening to mic and system audio; electron tests for the tray menu.

## M5. Sharing

Hosted on Cloudflare (G3). No accounts in this version: links are long random capability URLs; the app keeps an owner token per share to update or delete it.

1. **Worker + R2 + Durable Object** on mlch.app. Upload API (owner token, size caps, rate limit per install), viewer pages, delete. One Durable Object per shared mulch, which in this milestone relays the owner's op batches to viewers (one writer, many readers). M8 extends the same object to many writers.
   - Check: Worker tests (vitest with the Workers pool); upload, view, update, delete, wrong token refused, oversize refused.
2. **Share a deck or any artifact.** Share button on artifact cards and in the full-window viewer: uploads the file and its assets, copies the link. HTML served with the same sandbox as in the app (opaque origin, no network beyond its own assets), from the separate domain or subdomain decided in G3.
   - Check: shared HTML can't read cookies or call out (CSP test page); the link works in a fresh browser; re-sharing updates in place; delete makes it 404.
3. **Share the canvas, read-only and live.** Before sharing: a summary of what goes with it (items, files, documents; link cards to private mulches and sources show their title only, never the file). The viewer is the canvas in read-only mode, built as a static bundle served by the Worker; while sharing is on, the app streams op batches to the Durable Object and viewers update live (mid-call sharing).
   - Check: scenario: share, open the link in a separate browser, add a card in the app, it appears in the viewer within 2 s; stop sharing, the viewer says it's no longer live and keeps the last state; files not included in the share return 404.
4. **Copy into your own mlch.** "Open in mlch" on the viewer: `mlch://` link the desktop app handles, downloads the snapshot and assets, creates a new local mulch (a copy, noting where it came from). Without the app installed, the button offers the download.
   - Check: scenario: share from library A, open the link with an app on library B, the copy matches (items, files, edges), history starts fresh.

## M6. Onboarding

One checklist screen, live, fixing what it can, then a new mulch with the mic ready. No tours.

1. AI: Claude Code or Codex found and signed in; if not, what to install, re-checked live.
2. Transcription: local (download with progress) or Groq (paste key, tested).
3. Microphone permission; system audio permission (for calls, can be skipped).
4. Search model download with progress.
5. Optional: link a folder or Obsidian vault (M1 sources).
   - Check: scenario on a clean profile with each item missing in turn: the screen shows it and recovers once fixed; with everything present, it passes straight through.
   - George checks: wording (G5); someone non-technical tries it.

## M7. Packaged, signed, auto-updating release

1. `app.mlch.mac` bundle id, "mlch" in the Dock and menus, the helper signed and inside the bundle, hardened runtime with the microphone and audio-capture entitlements.
2. Notarize (G2), staple, DMG.
3. Auto-update (electron-updater, feed and builds on R2 at mlch.app).
   - Check: `electron-run --production` on the packaged app; `spctl --assess` passes; install on a clean user account, update from version n to n+1 works.
   - George checks: install on a second Mac (G6). Distribution terms resolved (G4) before sending to anyone.

## Testing, releases and updates (agreed 2026-10-12)

**Testing.** Day to day George runs `npm run app` (or `npm run electron:dev`); I fix what comes up. Once per round, a signed build (`npm run dist`) to catch what only packaging breaks (permission prompts, menu bar, `mlch://` links, the audio helper). Notarizing only for builds that go to other Macs.

**Releases.** Version in package.json; `npm run release` (to build): refuses with uncommitted changes or a failing check, builds, signs, notarizes, smoke-tests the packaged app, uploads the zip, its blockmap and `latest-mac.yml` (last) to R2 `releases/mac/`, served at mlch.app/releases/mac/. First install: a DMG.

**Updates.** electron-updater in the packaged app checks `latest-mac.yml` at launch and every 6 hours, downloads in the background, checks the signature (same Developer ID), installs on quit. No dialog. Only signed and notarized builds update.
- A bad release is undone by a newer one, never by deleting: hence the smoke test before upload.
- Old versions stay in use: the mulch format only changes with a migration that opens old files.
- Channels: `beta` (George) and `latest` (friends), two feeds in the same place.
- Models (Parakeet, search) are not in the app; they download to their folders once and are not touched by updates.

**App size.** Built 2026-10-12 as planned: **165 MB DMG, 168 MB update zip, 414 MB installed** (was 1.7 GB / 603 MB). Electron is 286 MB of the installed size; mlch's code and libraries about 110 MB.
- `scripts/package-app.mjs` stages build/app: Next's standalone output, its route runtimes, static files, the traced Electron side and search worker, one onnxruntime WebAssembly file, `cli.json` (tested CLI versions). No asar: few enough files that signing takes minutes.
- Claude Code and Codex are not shipped (src/lib/agent/server/cli.ts): the person's install when at least the tested version (looked for in ~/.local/bin, Homebrew, npm and bun folders; a Finder-opened app has no shell PATH), else the tested version downloaded from npm into Application Support (lockfile hash, Anthropic Team ID Q6L2SF6YDW / OpenAI 2DC432GLL2 checked), only for the AI in use; the other on Download. A failing install switches to the tested copy. New Claude Code / Codex releases reach people through their own installs; mlch releases move the tested version.
- Checked on the signed app outside the repo with a Finder-like PATH: installed CLIs used (Claude Code 2.1.296, Codex 0.160.1); with installs hidden, only Claude Code downloaded (about 98 MB), a real turn ran on it, Parakeet transcribed, search worked.
- First run downloads in the background: the CLI if needed (98–133 MB), Parakeet (600 MB), the search model (120 MB).
- Next: the daily check of the latest Claude Code / Codex against mlch's agent tests.

## M8. Collaboration (after the release)

Design now, build after M7. Extends M5's Durable Object from one writer to many.

- **Ordering.** The Durable Object gives every batch a sequence number; clients keep unconfirmed local ops and replay them on top of what arrives (most recent write wins per field).
- **Text.** One person edits a card's text at a time (shown to others); a real text merge (Yjs) only if that turns out too limiting.
- **People.** Join link (capability) plus a display name; origins become per person (`user:<id>`, `speech:<id>:<job>`); "the AI never touches what the person made" becomes "what any person made".
- **Undo** undoes only your own ops and skips anything someone has since changed.
- **Presence.** Cursors, who's editing what; over the same socket, not logged.
- **Agents.** Each person's own agent (their subscription) works on the shared mulch. The person whose input produced an item enriches it; long jobs take a lease from the Durable Object so only one runs and everyone sees it.
- **Files** to R2 (content-addressed already); each person's search index is built locally from the op stream.
- **Joining from the viewer**: "Join" on a collaboration link opens it in the person's mlch.
- Checks to write when the milestone starts: two app instances on one shared mulch with simulated latency and offline periods converge to the same state; undo tests across people; two agents never enrich the same item.

---

## Wording (G5)

Placeholders I'll add, collected here for you to replace. Existing ones from ROADMAP item 4 are included.

- Existing: "Queued", "Stop", "Stop all", "Show", "Retry", "Dismiss", "Starting", "making", "research", "Stopped when mlch quit.", "1 job is running." / "Quitting stops them. They can be retried later.", notifications, "Add Screenshot".
- M0: View menu "Zoom In", "Zoom Out", "Show All" (standard macOS menu words)
- M1: "Open", "Bring here", "Linked from", "Removed", "Sources", "Add folder", "Use without asking", "Only when asked", "mlch can add notes here", "Links: off / some / more"
- M2: "Transcription", "Local", "Groq", "Downloading model"
- M3: "New call", "Listening", "Stop listening", "Me", "Them", consent line (yours)
- M4: "Open at login"
- M5: "Share", "Copy link", "Stop sharing", "Live", "No longer live", "Open in mlch", what-is-shared summary (yours)
- M6: every line on the checklist screen (yours). Now: "AI", "Transcription", "Microphone", "Search", "Folders", "optional", "Sign in", "Check again", "Save", "Allow", "Download", "Try again", "Downloading", "Start", "Groq API key" (placeholder), "Setup checklist", "App", "Open at login"
- Added while building: "Links to your mulches and sources" (enrichment), "Remove", "Folder not found", "Indexing", "Indexing, N read of M", "N files", "Obsidian", "Connected there", "Calls" (prompt part), "Listening", "Stop listening", "Me", "Them", "Only the microphone: …", "Link copied", "Copy link", "Share again", "Delete link", "Sharing", "N items, M files, live / not live", "Show Call", "Stop Listening", "New", "New Call", "Open mlch" (menu bar), "Zoom In", "Zoom Out", "Show All", macOS permission prompts "Speech to text." and "Speech to text in calls.", "Download model", "Downloading model N%", viewer "Live", "No longer live", "Open in mlch", "Not found."
- Onboarding steps (src/components/welcome/Welcome.tsx; yours: "Welcome to mlch", "An AI app for non-linear thinkers.", "Your context"): "Get started", "Your AI" and its line, "Signed in as …", "… is on this Mac", "… is not on this Mac yet. mlch can download it.", "Connect Claude / ChatGPT" and its line, "Not on this Mac. mlch downloads the version it was tested with, from …", "Not signed in to …", "Finish signing in in your browser.", "Use is billed to the API account the key belongs to.", "Speech" and its line, "On this Mac", "600 MB download", "Private: audio never leaves your Mac. Works offline.", "Groq", "Needs a key", "Audio is sent to Groq to be transcribed. Nothing to download.", "Microphone and calls", "macOS asks you to allow these once.", "Microphone", "Try it", "Try again", "Say a sentence. The words appear here.", "Listening", "The speech model is downloading (N%). The test works once it is done.", "The other side of calls" and its two lines, "Asked", "Web and making" and its line, the three key lines, "Key saved", the two "Your context" paragraphs, "Add", "Obsidian vault on this Mac", "Calls and the menu bar" and its line, "Open mlch at login", "Ready", "“Start here” in your list shows how mlch works.", "Downloads continue in the background.", "Open mlch", "Back", "Continue", "Skip", "Downloading …"
- Install: "Move mlch to Applications?", "Move", "Not now", "Could not move mlch to Applications."
- Added 2026-10-12 (second round): "A whiteboard that thinks with you" screen (headline, paragraph, five lines, drafted with George), "Looking for … on this Mac", "Downloading …", Your context's three paragraphs, Calls screen line, "Add anyway", the broad-folder question, "N files (the first 20,000), M skipped", key field "Saved, ending in …", "From .env.local", "Checking", "Works", "Check", "Change", "Cancel", "The service does not accept this key.", "Could not reach the service to check the key. It is saved; try again when online.", "fal spend" and its line, the Keys lines in Settings, message bubble "Add to canvas", "Close", "Message" (dot during a call), transcript card "Call, <date>, <start> to <end> (N min)", "Listening.", "Nothing was heard.", "Me", "Them", notes title "Notes: …", job "Call notes"
- Added 2026-10-13: "Conversation" (panel title), "What you say and type, and what the AI does with it, shows here.", "→ N cards", "→ capturing", "→ instruction", "Working", "Done", "Show N items", "Instruction: let go of ⌥ to send", "Sending", "Present", "Fill the window", "16:9", "Full screen" (shared page), "Sharing", "Link copied", "Linked item, not shared", "Style" and its line and placeholder, "Close" (setup), "Edit", "Done" (side panel), "Archive", "Keep working", "Turn off", "N share links:", "Archived (N)", "Restore", "Delete for good", "Delete with its share links", "Transcribing…", "Watching…", "Nothing could be transcribed. …", Gemini key line, link preview descriptions "A canvas shared from mlch." / "Shared from mlch."
