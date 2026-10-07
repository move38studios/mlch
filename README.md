# Mulch

An app for non-linear thinkers.

Speak your stream of consciousness and have the ideas visually organized on an endless 2D canvas, with search results, associations and connections appearing as you go. Drop in documents, links and folders and they get incorporated.

Ideas emerge from the mess and from cross-pollination, and they happen at the intersections. Go linear only after the braindump.

## How it works

**Your mulches.** The home screen is a list of everything you have started, to go back to, and a button to start a new one.

**Braindump.** Starting a new one, you speak into the microphone. As you speak, the canvas populates with:

- the key things you said
- web search results
- relevant related ideas
- dictionary definitions
- examples
- connections between items
- small post-its with further questions

**Organize and add.** You can look at the canvas, rearrange it, and drop more things onto it (documents, links, files). They get incorporated.

**Speak again.** Click the mic to add more, or to ask the AI to act on it: organize it, clean it up, or produce a linear summary or write-up. Write-ups are produced as markdown documents and dropped onto the canvas.

**Folders and files.** Point Mulch at a folder and the AI explores it and builds a mulch out of its contents. You can also just ask ("look at my dev/briefbuster folder and describe its key ideas"); it reads files on your machine read-only and never looks into credentials or app data.

**Images.** The AI sees images: dropped images are captioned and their content joins the canvas.

**Made things.** Ask for a slide deck, a one-pager, a table or a diagram and it is made as an HTML page you can open full-window on top of the canvas (and present). PowerPoint, Word, PDF, spreadsheets and charts are made by Claude Code or Codex with their own tools, inside their sandbox. Files land in the mulch's folder and as cards on the canvas.

**Media.** Ask for images, video, voice, music or 3D models and the AI picks a model on fal, generates, looks at the result and redoes it if it misses. Cards show progress while generating. Paid per use with your fal key, with a daily cap.

**Search and research.** Cmd+K searches everything in a mulch, or across all of them, by meaning and by words, including the full text of documents and what you said. You can ask "find that image where…" or "do you remember the quote about…". Competitor scans and landscape questions run as research jobs that put sources, a comparison table and a write-up on the canvas.

**History.** Every mulch keeps its history. You can travel back in time to any earlier state.

**Sharing** (not built yet). You can share a mulch as a static, timestamped snapshot. A share link lets other people (or AIs) explore the canvas visually and open each file and document on it. Creating a link means sharing all documents attached to it.

## Platform

- macOS desktop app: Next.js wrapped in Electron.
- A web version may follow, so the app is built as a Next.js app first.

## AI

- No separate AI subscription. Mulch uses your existing Claude Code or Codex subscription.
- Some features use your own keys, entered in Settings: Groq (microphone), fal (media generation), Exa (research search), Firecrawl (reading pages and documents, optional).

## Running

Needs Node 24, and Claude Code and/or Codex installed and signed in with a subscription.

```sh
npm install
npm run app          # build, then open the desktop app
npm run app:start    # open the last build
npm run electron:dev # desktop app with live reload
npm run dev          # browser at http://localhost:3100 (no folder picker or key storage)
```

Keys: Settings in the app (stored in the macOS Keychain), or `.env.local` for development:

```
GROQ_API_KEY=...       # microphone (Groq Whisper)
FAL_KEY=...            # images, video, voice, music, 3D
EXA_API_KEY=...        # research search
FIRECRAWL_API_KEY=...  # optional: better link and document reading
```

Each mulch is a folder in `~/Documents/Mulch`. Logs are in `~/Library/Logs/Mulch`; Settings → Diagnostics saves a report for support.

## Not built yet

- Sharing snapshots as links.
- A packaged, signed Mac app (today it runs from this repo).
- Using your own Claude Code / Codex connectors (MCP) inside Mulch.
- Local transcription (Parakeet).
- Live collaboration.
