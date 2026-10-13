# mlch plan 3: a small public release

Friends use it; nobody is advertised to; everything is ready for anyone who finds it. Collected from George's testing of the signed 0.1.0 build on 2026-10-13. PLAN-2's open items (wording, a second Mac) are folded in here. Collaboration (PLAN-2 M8) comes after this.

## Status (2026-10-13, evening)

Built, checked and committed: R1-R6 and R7's site, admin, friend codes, account deletion and legal pages. `npm run check` (572 tests), cloud checks (57) and the scenarios pass (r1-fixes, home-search, menus, menubar, decks-pages, artifact-viewer). mlch.app is deployed with the landing canvas, legal pages, /download and /admin (403 until Access is set up); the D1 migration is applied. Version 0.2.0; a signed build was made, not yet notarized or uploaded.

Not done, and why:
- **Notarizing and publishing 0.2.0:** no notarization credentials on this Mac (G2). After `xcrun notarytool store-credentials mlch`: `APPLE_KEYCHAIN_PROFILE=mlch npm run release -- --channel latest --notes "First early release."` (first release straight to latest so Download works; later ones to beta first).
- **Stripe live:** the Stripe CLI's live key can read but not create (G3).
- **/admin login:** Cloudflare Access needs the dashboard (G4).
- **Web Analytics:** the API refuses wrangler's login; the beacon is wired (G5).
- **Public repo:** waits for the licence (G1); no GitHub repo exists yet.
- **R2 evals** on recorded inputs: not run (they need a live model and spend; next session).

## Needs George

- **Resolved 2026-10-13:** distribution terms (George checked; revisit if issues come up); Stripe tax registration (done); a real call (done); the icon (a display glitch on George's external monitor, not ours).
- **Agreed 2026-10-13:** legal pages written by me, "as is, at your own risk", with move38 B.V.'s details; data deletion by email to legal@m38.ai, carried out from /admin; the landing page is a canvas.
- **G1. Licence** for the public repo (e.g. MIT for the app, AGPL for the server), and where it lives on GitHub (the landing shows a Source code link once `VITE_MLCH_SOURCE_URL` is set at build). Git history can stay: scanned, no keys in it; it does hold working notes (docs/research, the old drafts), which become public with it.
- **G2. Notarization:** `xcrun notarytool store-credentials mlch` (Apple ID with an app-specific password, team FP3X7G6BU7), once.
- **G3. Stripe live key:** in the Stripe dashboard (live), a restricted key with write access to Customers, Checkout Sessions, Subscriptions, Billing portal, Products, Prices, Coupons, Promotion codes, and read on Invoices. With it I create the live product and price, the webhook, and set the Worker secrets. legal@m38.ai must receive mail (deletion requests).
- **G4. Cloudflare Access for /admin** (Zero Trust, move38 account): a self-hosted application "mlch admin" on mlch.app paths `admin` and `api/admin`, an Allow policy for emails ending in @m38.ai, login with Google or a one-time PIN; then `ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`) and `ACCESS_AUD` (the application's AUD tag) in `cloud/wrangler.mlch.jsonc` vars, and deploy.
- **G5. Web Analytics:** Cloudflare dashboard, Analytics & Logs, Web Analytics, add mlch.app (manual JS snippet); put the token in `cloud/landing/analytics.txt` and deploy.
- **G6. Tests only George can do:** install 0.2.0 on a second Mac and on a clean user account; update from 0.2.0 to the next; a friend code from sign-up to first share. Read the four legal pages (terms add commitments: liability capped at 12 months' payments, 30 days' notice and a pro-rata refund if the service ends).

## R1. Fixes from testing

1. **Setup, call audio.** macOS has no public check for the System Audio Recording permission (a denied tap is silent, not an error), so the step shows no status. Title "Call audio"; "To hear the other people on a call, mlch records your Mac's sound during calls. macOS asks you to allow this." After asking: "If it is off: System Settings > Privacy & Security > Screen & System Audio Recording." (agreed). `SystemAudio` in Welcome.tsx.
2. **Setup, Sharing.** With mlch.app chosen, Continue stays off until subscribed; No sharing and Your own server still go on. The step checks the account again when the window comes back from Checkout. (`canContinue`, Welcome.tsx:323.)
3. **"Open in mlch" on your own share opens your mulch** (found by share id and server in the library's `shares.json`; archived: unarchived; a made-file share opens with that file shown). Someone else's share: always a new copy. Label stays "Open in mlch". (`importShare`, shares.ts:429.)
4. **Card resize.** Lag: while dragging, the text reflows, the new height is written to the mulch and `toFlowNodes` resets the width to the stored one, so the card fights the pointer (Canvas.tsx:110, :171). Keep the live width while resizing and write the height at the end. **Decided: width and height.** A card taller than its text shows space below; shorter clips with a fade at the bottom, the full text on open. The stored `h` becomes the person's choice (`userTouched`); without one, height follows the text as now.
5. **Shared canvas with linked notes.** Link cards became full write-ups in the share and covered their neighbours. In a share a link card keeps its link-card look and size (title, short excerpt, source name) and carries the text; clicking opens it in the viewer's side panel. "Open in mlch" makes them write-ups at that size. HTML tags in notes are stripped to text. (`linkedContent`, shares.ts:165.)
6. **⌘K everywhere.** A Search item (⌘K) in the app menu: on home it focuses the search field, in a mulch it opens the palette, elsewhere it opens the palette over the whole library.
7. **Settings top bar stays put:** back arrow and title in a sticky bar (also the window's drag area), hairline once scrolled; ⌘[ and Esc go back.
8. **Checkboxes black:** one `accent-color: var(--ink)` in globals.css for every checkbox (Open at login and "mlch can add notes here" were blue).
- Check: setup scenario with mlch.app chosen (Continue off until the account reports a subscription); share scenario opening one's own share link (no new mulch, archived one restored); a shared canvas with a linked folder note renders at link-card size; resize scenario (width follows the pointer during the drag).

## R2. The AI as a thinking partner

1. **Default models by how often a lane runs.** Capture (every utterance): fast. Enrichment (every batch): a strong model at moderate effort. Instructions, making, research: the strongest. Codex now runs every lane on `gpt-5.6-luna` (codexStatus.ts:21); George's test on gpt-6-astra (enrichment, instructions) and gpt-6.1-sol (capture) worked well, so the gpt-6 family becomes the default, after checking its sub-agent tools stay off. Claude: haiku / sonnet / sonnet, review the same way. No model question in setup; Settings keeps the choice.
2. **Prompts** (prompts.ts, tools.ts, jobs.ts). Evidence: asked to find something in George's essays, the AI added two cards in its own paraphrase, in bold, with a file path in the text, no quote and no link.
   - Base, every lane: return the ball (a sharper question, a counterpoint, a connection, a concrete case); no conclusions or plans unless asked; no praise, no agreeing for its own sake, no restating the person's point; test claims; ask when an idea is thin; the person's words are quoted, never paraphrased in the AI's voice; fewer better items; adding nothing is a good answer.
   - Rule for where things go: canvas items for what is worth keeping and thinking with; `tell` for a direct answer, a refusal or one clarifying question; `say` for status only.
   - Enrichment: 1-3 items per batch, at most 5, none for small talk; at most one when the AI's items nearby already outnumber the person's or its earlier questions are unanswered; vary kinds; prefer a counterexample, a tension with something said earlier (quote both), a question only the person can answer. Questions tied to the person's words, never generic, at most one per batch. New items marked as said or from a source, so sources are enriched lightly. During a call: at most 2.
   - Instructions: finding things in notes or other mulches: `link_to` with a reason, cards as verbatim quotes with the source in the title. "What do you think": an honest view, the strongest point against it, one question back. Write-ups: the person's phrasing for their ideas, additions marked. `<elsewhere>` is background. Never reword the person's items while doing something else.
   - Capture: a point is one idea, not one sentence; restatements merge.
   - Calls: a disagreement between me and them becomes two items connected "disagrees".
   - Ingest: 3-8 items, enrich 2-3 of them. Folder lane: fix the garbled line "Add a `doc` is not available" (prompts.ts:86).
   - Research: the resume check's "at least 5, aim for 8-15" (jobs.ts:875-880) contradicts "fewer, deeper for a literature question"; use the number the brief needs. "Where the person's idea sits, if the brief has one."
   - Code: `add_nodes` refuses Markdown and more than ~30 words in idea and question cards, with an error saying what is allowed (write_doc for longer). One rule for connections: connect only when the label says something; `near` alone for closeness. tools.ts:938's error says what is allowed (save a new file). Consider dropping `@x,y` from lane prompts.
3. **fal models.** It used `fal-ai/flux/schnell` (2024): fal's default order is trending, schnell is first, and our search shows the model's last update (2026) instead of its release date (fal.ts:93).
   - Search: show the release date (`metadata.date`), sort by recent when there is no query, show group and tags, send the fal key (anonymous calls hit 429).
   - `src/lib/media/picks.ts`: a quality and a fast pick per task (image, edit, text to video, image to video, speech, music), with the date checked; listed first in `media_search` (checked to still exist), followed by newer entries than the picks. Picks as of 2026-10: image nano-banana-2.1 / gpt-image-2.5 / flux-3, fast seedream v5 flash; edit the same families; video seedance-2.5, minimax h3-max, fast h3-max-turbo; image to video kling v3 pro, fast h3-max-turbo, vidu q4; speech eleven-v4 / turbo; music lyria-3.5. A release-checklist step and `scripts/fal-picks.mjs` keep it current.
   - Prompt: the quality pick unless drafts, many variations or speed are asked for; beyond the picks only for something specific (transparency, a style, lip-sync, 3D, upscaling) or a newer model from a known lab; web research before anything over about $1 or a model the AI does not know; testing is not a reason for the cheapest.
4. **Default look of what the AI makes.** The house style setting starts filled with mlch's look (paper, black ink in three strengths, Schibsted Grotesk, generous space, at most one amber accent, no gradients or shadows) and a small "made with mlch". It is text the person can rewrite or delete, unbranding included; nothing is hard-coded. Unset means the default, cleared means none; "Reset to default" brings it back. The font ships with the app and the default text names its path, so the AI can inline it (made files have no network). The quick PowerPoint builder (pptx.ts) has no look of its own beyond the house style.
- Check: agent evals for each lane on recorded inputs (items per batch, quotes kept, no Markdown in ideas, a question back on "what do you think"); a squirrel-style run picks a current image model; a deck with no house style set comes out in mlch's look with "made with mlch", and with the style cleared, without it.

## R3. Decks and pages

The squirrel deck: one rule (`.split{display:grid!important}`) showed slide 2 at all times, so the current slide stacked below the window with scrolling off; slides sized to the window instead of 16:9; keys and click only. Every viewer (app, shared canvas, shared file) assumes 16:9, so pages sit letterboxed and a share on a phone is 360×200.

1. **Declared kind.** `write_artifact` takes `kind: "deck" | "page"`; stored on the node and as `<meta name="mlch:kind">` in the file. No kind: a page, unless it looks like an old deck.
2. **Decks: the AI writes slides, the app the rest.** `src/lib/artifacts/deck.ts` builds the file with a small inline player: fixed 1920×1080 slides scaled to fit any screen, exactly one shown, keys, click, wheel, swipe, `#n` in the address, a counter, `window.__mlchDeck` for checks. No look of its own (that comes from the house style).
3. **Viewers by kind** (ArtifactViewer.tsx, cloud/src/frame.ts, the shared canvas): a deck fills the stage and letterboxes itself, no Fill toggle, Full screen hidden where it does nothing (iPhone); a page fills the stage and scrolls, edge to edge on a phone. Canvas thumbnails: a deck's first slide, a page's top.
4. **preview_artifact checks:** a deck: every slide, reporting overflow and more than one slide visible; a page: 1280×800 and 390×844, reporting sideways scroll and text under 12px. Errors say what is allowed.
5. **Prompts:** a deck template (title, statement, two columns, quote, number) in px at 1920×1080, no navigation script; pages: one responsive column.
- Check: deck.ts unit tests; a scenario makes a deck and a page, checks them in the app viewer and in a shared link at desktop and phone sizes (one slide visible, swipe moves, page scrolls).

## R4. Home: search and the list

1. One field. Results in order: mulches whose title matches (the list itself filters as you type, words in any order); inside mulches, one row per mulch (best snippet, matched words marked, "N more" opens that mulch's search at the hits); in your folders, as its own section. Archived mulches only in results, marked, last.
2. Typing anywhere on home searches; ↑/↓ through every section; Enter opens (a hit at its item); Esc clears.
3. Empty field: most recent first by last opened or changed, headed Today / This week / Earlier; the first ~50, more as you scroll.
4. Content hits: a small boost for recent ones; each shows its kind (card, made file, file, note) and date with time.
- Not now: search syntax, saved searches, pinning.
- Check: a scenario with a library of 200 mulches (title filter instant, keyboard through sections, scroll loads more).

## R5. Shell: menus and menu bar

1. **App menu:** About mlch, Check for Updates…, Settings… (⌘,), Hide, Quit.
   - File: New (⌘N), New Call (⌃⌘L), Open Recent (10), Search… (⌘K), Add Screenshot, Share…, Close.
   - Edit: standard, with Undo and Redo reaching the canvas when no text field is focused (check what they do now).
   - View: Conversation (⌘J), Zoom In, Zoom Out, Show All, Full Screen.
   - Go: Home (⇧⌘H), Back (⌘[).
   - Window: standard.
   - Help: mlch Help (mlch.app), Save Support Report (Settings → Diagnostics), Open Logs, Restart Local Server.
2. **Menu bar:** keep 5 recent; mark the ones working or with new results; add Search… and Settings…; "Restart to Update" once an update is ready.
3. **Dock menu:** New, New Call, the 5 recent.
- Check: electron tests for the menus (every item has a handler), tray and dock menus.

## R6. Open source, releases and updates

What exists: electron-updater checks mlch.app/releases/mac at launch and every 6 hours, downloads quietly, installs on quit, no dialog (main.cjs:236); `scripts/release.mjs` uploads the zip, blockmap and `latest-mac.yml` (last).

**Builds by others** (the usual practice for open-source desktop apps: official builds update, builds from source do not):
1. **Official and source builds differ by one switch.** Only official builds (made by `npm run release`, `MLCH_OFFICIAL=1`) carry the update feed. A build from source has updates off and says "Built from source" in About and Settings, so nobody's own build updates itself into ours (on a Mac it would fail anyway: electron-updater requires the same signing identity) and nobody is stuck on a feed they don't control. A fork can set its own feed (`MLCH_UPDATE_URL`) and its own signing identity.
2. **Source builds get their own bundle id** (`app.mlch.mac.dev` unless official), so they don't share Keychain entries, macOS permissions or the `mlch://` handler with an installed official app. Its own name in the Dock ("mlch (dev)").
3. **`npm run dist:unsigned` stays the one command** for someone building for themselves, documented in the README with what it needs (Node, the swift.org toolchain or Xcode for the audio helper).
4. **Sharing defaults to mlch.app in every build**; a source build can point at its own server in Settings as today. The server never trusts the app: accounts and keys are checked on the server, so a modified app gains nothing.
5. **Releases built from a tag**, in GitHub Actions or locally by the same script, with the commit in About: anyone can see which source a release came from. The DMG also goes to GitHub Releases; the update feed stays on mlch.app.

**Our releases:**
6. `npm run release`: refuses with uncommitted changes or a failing check; bumps the version; builds, signs, notarizes; smoke-tests the packaged app outside the repo; uploads; tags.
7. Channels: `beta` (George) and `latest` (friends), two feeds in the same place; a release goes to beta first.
8. People rarely quit a menu bar app that opens at login, so an update can wait for days: "Restart to Update" in the menu bar and the app menu once it has downloaded, and a restart on its own when nothing is running and no window is open.
9. Check for Updates… and the version in Settings. Release notes: one short line per release, shown in About.
10. A bad release is undone by a newer version (electron-updater does not go back).
11. Compatibility: the app sends its version to mlch.app; the Worker keeps accepting older apps and can answer "Update mlch to keep sharing" when a change truly breaks them. The mulch format only changes with a migration. The tested Claude Code / Codex versions move with releases.

**Making the repo public:**
12. Scanned 2026-10-13: no keys in the 92 commits' history (Stripe, webhook, Groq, fal, Google, AWS, private keys). Personal details only in docs (ROADMAP, TESTING, drafts: George's email, local paths).
13. Recommended: a new public repo starting from one commit of the cleaned tree; the full history stays in this private repo. Reasons: history holds working notes, research and drafts not meant for the public, and nothing in it is needed to build. Before that commit: remove or move private docs (docs/research, docs/drafts, TESTING's personal parts, ROADMAP's account notes), check THIRD_PARTY_NOTICES, add the licence (G1), a README for building, CONTRIBUTING (short), SECURITY (how to report). cloud/ goes in, with the own-server guide: it is what "Your own server" runs.
- Check: a source build (`npm run dist:unsigned`) runs next to an installed official app without touching its settings, permissions or links, and has updates off; update from n to n+1 on a clean user account (G2); the beta feed is not seen by latest.

## R7. mlch.app: landing canvas, legal pages, admin, friend codes, live payments

1. **The landing page is a canvas**, the product as its own preview: the read-only viewer's canvas (cloud/viewer, the app's components) made editable in the browser, held in memory, back to the start on reload. No AI, nothing saved or sent. A few cards: the logo, the value proposition in the onboarding's words ("A whiteboard that thinks with you", "An AI app for non-linear thinkers."), a big Download button (the latest signed DMG from R2), GitHub (where the source lives), the own-server guide, the legal pages. Visitors can move cards, write a note, connect two. On a phone: the cards fitted to the screen, pan and zoom, Download says "for Mac".
2. **Legal pages** (privacy, terms, refunds, company), short and plain: the app is provided as is, used at one's own risk, no warranty, liability limited as far as the law allows. What the law still needs (EU) goes in too: who runs it (move38 B.V., Poortwachter 81, 1188 CH Amstelveen, the Netherlands; KVK 99641313; VAT NL869072663B01), what personal data is kept (Google email, Stripe customer, shares) and why, who processes it (Cloudflare, Stripe, Google), how to have it deleted (an email to legal@m38.ai; we wipe the account from /admin), the 14-day withdrawal right for the subscription and how it is waived when sharing starts. Replaces docs/drafts. George reads them before they go up.
3. **/admin** behind Cloudflare Access (m38.ai, its own Access application); the Worker checks the Access token again on `/api/admin/*`. Friend codes: create (code, how many uses, optional expiry), list with uses, turn off. Accounts: email, subscription, code used, number of shares. **Delete account** (on request, GDPR): cancels the Stripe subscription and deletes the Stripe customer, stops and deletes every share the account made (R2 files, Durable Object state), deletes sessions and the account row; logs only that a deletion happened (date, by whom), not who was deleted.
4. **Friend codes** (as in ~/dev/onedollarconcept): a Stripe coupon (100% off, forever, only the mlch product) and promotion code, kept in D1; Checkout accepts codes and asks for a card only when there is something to pay (`payment_method_collection: if_required`); the webhook checks a discount is one of ours.
5. **Live mode:** a restricted live key made with the Stripe CLI (Customers, Checkout Sessions, Subscriptions, Billing portal, Prices: write; Promotion codes and Coupons: write for admin) as `STRIPE_SECRET_KEY`, the live product and price (`mlch_sharing_yearly`, $12/year, tax exclusive), the live webhook, the Google sign-in screen published once the legal pages are up. Roll the test key that showed up in a transcript.
- Check: Worker tests for admin auth (no Access token: 403), codes (create, use, turn off), account deletion leaves nothing of the account in D1, R2 or Stripe, a 100% code subscribing without a card; the landing canvas on desktop and phone sizes; in test mode end to end, then one real live subscription refunded.

## R8. Release checklist

- [ ] Licence chosen (G1); public repo from one clean commit
- [ ] Legal pages live; Google sign-in published; Stripe live
- [ ] R1-R7 built, `npm run check` and the scenarios pass
- [ ] No placeholders left in the app's wording
- [ ] Signed, notarized build through `npm run release` on beta; George's tests (G2) pass on it
- [ ] Fresh install on a clean user account: setup, a share, "Open in mlch", a friend code
- [ ] Update from that build to the next one
- [ ] Support path: Save Support Report and an address to send it to
- [ ] Released to latest; Download link on mlch.app; friend codes sent
