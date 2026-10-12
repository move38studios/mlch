# Testing a round

One pass through everything, on the packaged app as a new person would get it. About an hour. Note what breaks or feels wrong as you go and send it in one message (screenshots help). Settings → Diagnostics saves a support report to ~/Downloads with the logs.

## 0. Set up

1. Quit any running mlch (`npm run app` and the packaged app use the same port).
2. Open `dist/mlch-0.1.0-arm64.dmg` and drag mlch to Applications. It is signed, not notarized: fine on this Mac.
3. Start it as a new person would, with an empty library and profile, so your real mulches, settings and keys are not touched:

   ```sh
   open -n --env MLCH_LIBRARY=$HOME/mlch-test --env MLCH_ELECTRON_USER_DATA=$HOME/mlch-test-profile /Applications/mlch.app
   ```

   Optional, to watch the downloads happen too (about 720 MB again): first `rm -rf ~/Library/Application\ Support/mlch/models ~/.mlch/models ~/Library/Application\ Support/mlch/cli`.

   Afterwards, `rm -rf ~/mlch-test ~/mlch-test-profile`. To test with your real mulches instead, open mlch from Applications normally.

## 1. First run

- The first-run screen opens. **AI:** Claude and Codex with your accounts. For each: your subscription with the box to tick, or an API key. If both are usable, pick the default. Start stays off until one is usable.
- **Transcription:** On this Mac by default. **Downloads:** speech and search progress.
- **Keys:** Exa, fal, Firecrawl, each with Get a key (opens the browser). Skip or paste.
- **Folders:** your Obsidian vault offered if Obsidian knows it; Add folder for any other.
- Start: the list, with "Start here" in it (not opened).

## 2. Start here and moving around

- Open Start here. Read it: is it right, is anything missing?
- Mouse wheel zooms at the pointer; trackpad two fingers pan, pinch zooms; drag the empty canvas pans; Space-drag pans; Shift-drag selects; ⌘+ ⌘− ⌘0; View menu has the same.

## 3. Thinking out loud

- New. Press the mic: macOS asks for the microphone (first time only). Talk for a minute or two about something real.
- Cards appear as you talk; then enrichment (sources, definitions, examples, questions) in their colours, dotted connections.
- Type a thought; type `/organize this`; type "write a summary". Double-click a card to edit; undo with ⌘Z.
- Leave a brand-new empty mulch: it should disappear from the list.

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
- Close the window: mlch stays in the menu bar (the icon has a dot while listening). Stop Listening from the menu.

## 6. Sharing

- In a mulch: Share (header). The link is copied. Open it in a browser, and on your phone.
- Add a card or speak in the app: it appears in the browser within seconds. Stop sharing: the page says it's no longer live.
- On a deck card: Share. The link opens the deck on its own.
- In the shared canvas page: Open in mlch. It should open mlch with a copy as a new mulch.
- Delete link from the Share menu: the page stops working.

## 7. Making things and research

- "Make a PowerPoint on …", "research the competitors of …", "make an image of …" (fal key). Long jobs show in the header, keep running while you look elsewhere, notify when done, can be stopped and retried.
- Quit while one runs: mlch asks first.

## 8. Settings

- AI: switch between subscription and API key (a key bills your API account), models per lane, sign-in state.
- Transcription: switch to Groq and back.
- Prompts: edit one, see it used, Reset to default.
- App: Open at login; Setup checklist goes back to the first-run screen.

## Not in this round

Placeholder wording everywhere (yours to replace: docs/PLAN-2.md, Wording). Areas and headings during a call. Collaboration. Notarizing and updates (after this round).
