# npkn (napkin)

An app for non-linear thinkers.

Speak your stream of consciousness and have the ideas visually organized on an endless 2D canvas, with search results, associations and connections appearing as you go. Drop in documents, links and folders and they get incorporated.

Ideas emerge from the mess and from cross-pollination, and they happen at the intersections. Go linear only after the braindump.

## How it works

**Napkins.** The home screen is a list of your napkins to go back to, and a button to start a new one.

**Braindump.** Starting a new napkin, you speak into the microphone. As you speak, the canvas populates with:

- the key things you said
- web search results
- relevant related ideas
- dictionary definitions
- examples
- connections between items
- small post-its with further questions

**Organize and add.** You can look at the canvas, rearrange it, and drop more things onto it (documents, links, files). They get incorporated into the napkin.

**Speak again.** Click the mic to add more, or to ask the AI to act on the napkin: organize it, clean it up, or produce a linear summary or write-up. Write-ups are produced as markdown documents and dropped onto the canvas.

**Folders.** Point npkn at a folder and the AI explores it and builds a napkin out of its contents.

**History.** Every napkin keeps its history. You can travel back in time to any earlier state.

**Sharing.** You can share a napkin as a static, timestamped snapshot. A share link lets other people (or AIs) explore the canvas visually and open each file and document on it. Creating a link means sharing all documents attached to that napkin.

## Platform

- macOS desktop app: Next.js wrapped in Electron.
- A web version may follow, so the app is built as a Next.js app first.

## AI

- No separate AI subscription. npkn uses your existing Claude Code or Codex subscription.
- Some features may ask for additional keys (for example Firecrawl for web scraping).

## Running

Needs Node 24, and Claude Code and/or Codex installed and signed in with a subscription.

```sh
npm install
npm run app          # build, then open the desktop app
npm run app:start    # open the last build
npm run electron:dev # desktop app with live reload
npm run dev          # browser at http://localhost:3100 (no folder picker or key storage)
```

Keys: Settings in the app (stored in the macOS Keychain), or `.env.local`:

```
GROQ_API_KEY=...       # microphone (Groq Whisper)
FIRECRAWL_API_KEY=...  # optional: better link and document reading
```

Napkins are folders in `~/Documents/npkn`.

## Not in V1

- Live collaboration on a napkin.
- Sharing snapshots as links.
- Local transcription (Parakeet).
