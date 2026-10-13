# Testing a round

One pass through everything, on the packaged app as a new person would get it. About an hour. Note what breaks or feels wrong as you go and send it in one message (screenshots help). Settings → Diagnostics saves a support report to ~/Downloads with the logs.

## 0. Set up

1. Quit any running mlch (`npm run app` and the packaged app use the same port).
2. Open `dist/mlch-0.1.0-arm64.dmg` and drag mlch to Applications. It is signed, not notarized: fine on this Mac.
3. Start it as a new person would. Either:
   - **Clean Mac** (as on 2026-10-13, see "Where things stand" in docs/ROADMAP.md): open mlch from Applications normally. Library, settings, keys, models and the downloaded CLIs are gone, so everything downloads again.
   - **Keep your real mulches**: start it with an empty library and profile instead:

     ```sh
     open -n --env MLCH_LIBRARY=$HOME/mlch-test --env MLCH_ELECTRON_USER_DATA=$HOME/mlch-test-profile /Applications/mlch.app
     ```

     Afterwards, `rm -rf ~/mlch-test ~/mlch-test-profile`.

## 1. First run

Onboarding goes one step at a time; Back works everywhere, and downloads show at the bottom.

- **Welcome**, then **A whiteboard that thinks with you** (what mlch does).
- **Your AI**: Claude and ChatGPT. While mlch looks for Claude Code and Codex it says "Looking for …", then whether each is on this Mac and who is signed in. Pick one.
- **Connect**: download Claude Code / Codex if it isn't on this Mac (progress shown); your subscription (Sign in if needed, then the box to tick) or an API key. Continue stays off until it works.
- **Speech**: On this Mac (starts the 600 MB download) or Groq (key).
- **Microphone and calls**: while the speech model downloads, Allow (the microphone prompt); once it is in, Try it shows the words you say. Allow under "The other side of calls" raises macOS's System Audio Recording prompt.
- **Web and making**: Exa, Firecrawl, fal, Gemini (watches YouTube videos), each with Get a key. A saved key shows its last four characters, is checked with the service (Works, or why not), and can be changed or removed. Skip.
- **Your context**: what to add and what not, what mlch reads. Your Obsidian vaults offered; Add folder as many times as you like; each shows its file count and how many were skipped. Adding your home folder, Documents or a whole disk asks first.
- **Calls**: what a call does; Open at login.
- **Sharing**: mlch.app (chosen), No sharing, Your own server. Under mlch.app: Sign in with Google (see 6).
- **Ready**: Open mlch goes to the list, with "Start here" in it (not opened). Settings → App → Setup goes back through the steps.
- With nothing in the list, the home screen is the wordmark and New, centred.

## 2. Start here and moving around

- Open Start here. Read it: is it right, is anything missing?
- Mouse wheel zooms at the pointer; trackpad two fingers pan, pinch zooms; drag the empty canvas pans; Space-drag pans; Shift-drag selects; ⌘+ ⌘− ⌘0; View menu has the same.

## 3. Thinking out loud

- New. Press the mic: macOS asks for the microphone (first time only). Talk for a minute or two about something real.
- Cards appear as you talk; then enrichment (sources, definitions, examples, questions) in their colours, dotted connections.
- Type a thought; type `/organize this`; type "write a summary". Double-click a card to edit; undo with ⌘Z.
- Leave a brand-new empty mulch: it should disappear from the list.
- Connections: hover a card for its four points; drag from any of them; the card under the pointer shows its points and the nearest fills in.
- Ask a question with `/` ("/what do these have in common?"): the answer is a bubble above the input until you close it or type again; Add to canvas makes it a card. Ask for something it can't do: it says why in a bubble.
- "/erase everything": cards, boxes, documents and made files all go.
- Conversation (⌘J, the speech-bubble button): closed at first; what you say and type, "→ N cards" / "→ instruction" under it (click to see them), the AI's answers (it opens by itself for one), results with Show / Stop / Retry. Opened cards now show on the left.
- Hold ⌥ (not in a text field) and speak: the amber pill; let go and it is one instruction. Thinking out loud continues around it.
- Room noise, typing or music while the mic is on: nothing is sent until you speak.
- Drop or paste: a YouTube or Vimeo link (plays in the card; with a Gemini key it gets a summary and transcript), a link straight to a picture or PDF (becomes the file), an audio or video file (plays, transcribed). Ask the AI for "the diagram from that page" or "this PDF": it adds the file.
- Pictures: corner handle to resize (any card), double-click to see it full size, edit its description.
- Home: hover a mulch for Archive (asks about share links if it has any); Archived (N) at the bottom: Restore, Delete (turns its links off).

## 4. What you already know

- Settings → Sources: add a folder of your notes (or the vault). It indexes (count shown). Try "Only when asked" on one.
- In a mulch, talk about something those notes cover. A link card should appear by the related card, the connection labelled with why. Talk about something unrelated: no link.
- Click a link card: the side panel shows it in full; Open (a vault note opens in Obsidian); Bring here makes a real card.
- In another mulch you linked into: the link icon in the header lists who links here.
- ⌘K, All: results from mulches and from the folder.
- Allow "mlch can add notes here" on the vault, then ask "save a summary of this to my vault".

## 5. A call

- From the menu bar icon (the small m square): New Call. Or ⌃⌘L from anywhere.
- macOS asks for the microphone and for System Audio Recording (first time). Allow both.
- Join a real call (or play a podcast or YouTube talk). The amber Listening bar shows two levels: you and them.
- Cards arrive about every 30 seconds: ideas, decisions, to-dos, questions, said by whom. Try headphones and speakers.
- While it listens, type "make a quick deck from what we just discussed". A deck card should appear within a couple of minutes, without stopping the listening.
- A transcript card appears when the call starts and fills in every 15 seconds (Me / Them, with times). When the call ends its title gets the end time and length, and a notes card (summary, decisions, to-dos, open questions) arrives beside it.
- Close the window: mlch stays in the menu bar (the icon has a dot while listening). Stop Listening from the menu.

## 6. Sharing

Stripe is in test mode: pay with card 4242 4242 4242 4242, any future date, any CVC. Google sign-in works only for george@m38.ai until the sign-in screen is published (docs/ROADMAP.md).

- Settings → Sharing (or setup): Sign in with Google. The browser opens; pick george@m38.ai; the page says "Signed in as …" and asks to open mlch; mlch shows "Signed in as …".
- Share menu before subscribing: "New links on mlch.app need a subscription." and Sharing settings. Subscribe, $12 a year: Stripe Checkout in the browser, with tax added for your address. Pay with the test card; back in mlch: "Subscribed, renews …". Manage subscription opens Stripe's page (cancel there: the old links keep working, new ones are refused).
- A canvas with a link card to another canvas: the Share menu says "Also shared: what 1 link card links to". In the shared page the linked item appears as an ordinary card with its content (not a link).
- No sharing: the Share buttons are gone (canvas header, deck cards, the deck viewer).
- Your own server (optional, for the technical route): follow mlch.app/server, then enter the address and key. Check says Connected; new links are on your server; links made before stay on mlch.app.
- In a mulch: Share (header). The link is copied. Open it in a browser, and on your phone.
- The page has the mlch tab icon and the canvas title; a mouse wheel zooms at the pointer, the trackpad pans.
- Add a card or speak in the app: it appears in the browser within seconds. Stop sharing: the page says it's no longer live.
- On a deck card: Share (says Sharing, then Link copied). The link opens the deck in a frame with Full screen and Fill the window.
- Paste a shared link into Slack or iMessage: a preview with the title and a picture (the canvas as shared, or the deck's first slide).
- In the shared canvas page: Open in mlch. It should open mlch with a copy as a new mulch.
- Delete link from the Share menu: the page stops working.

## 7. Making things and research

- "Make a PowerPoint on …", "research the competitors of …", "make an image of …" (fal key). Long jobs show in the header, keep running while you look elsewhere, notify when done, can be stopped and retried.
- Quit while one runs: mlch asks first.

## 8. Settings

- AI: switch between subscription and API key (a key bills your API account), models per lane, sign-in state.
- Keys: each with what it is for, last four characters, Check, Change, Remove. fal spend: what fal cost today and the daily cap.
- Transcription: switch to Groq and back.
- Prompts: edit one, see it used, Reset to default.
- App: Open at login; Setup checklist goes back to the first-run screen.

## Not in this round

Placeholder wording everywhere (yours to replace: docs/PLAN-2.md, Wording). Areas and headings during a call. Collaboration. Notarizing and updates (after this round).
