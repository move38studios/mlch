# mlch

*Say "mulch".* A whiteboard that thinks with you: an AI app for non-linear thinkers, for Mac.

You talk or type; mlch maps it onto an endless canvas while you speak, looks things up, connects it to what you explored before, and makes the deck when you ask. The AI runs on your own Claude Code or Codex subscription.

**Early release (0.2.0).** Expect rough edges. Download: [mlch.app](https://mlch.app). MIT licensed.

This README is for building, forking, self-hosting and contributing. CLAUDE.md describes the architecture in detail (it is also what coding agents working on mlch read first).

## What is in this repository

| Folder | What it is |
|---|---|
| `src/`, `electron/` | The Mac app: a Next.js app inside Electron. The canvas, the AI lanes, search, sharing, voice. |
| `native/mlch-audio/` | A small Swift helper: speech to text on the Mac (Parakeet), and the Mac's sound during calls. |
| `cloud/` | The sharing server (a Cloudflare Worker): shared links, the viewer, accounts for making shares, mlch.app itself. |
| `scripts/` | Packaging and releases, and scenarios that drive the real app for testing. |

## How it works, briefly

- **A mulch is a folder** in your library: the canvas (`mulch.json`), every change (`events.jsonl`), history, files. Every change is recorded as an operation, so it can be undone and replayed.
- **The AI** is Claude Code or Codex on your Mac, run through the Claude Agent SDK or Codex's app server with mlch's own tools. Several AI jobs run side by side: capturing what you say, adding to it, carrying out instructions, research, making files. Making files runs in a macOS sandbox.
- **Search** is one local SQLite index with local embeddings, no server.
- **Sharing** uploads a canvas or a made file to a sharing server (mlch.app, or yours), where anyone with the link can view it.

## Your data

- The library folder is `~/Documents/mlch` until you choose another in Settings, Library (a synced folder such as iCloud Drive or Dropbox works when one Mac uses it at a time). Settings live in the library too.
- Keys are in the macOS Keychain. Logs are in `~/Library/Logs/mlch`.
- What leaves the Mac: what the AI needs, to your AI provider; audio to Groq only if you choose Groq; what you share, to the sharing server; services you add keys for (fal, Exa, Gemini, Firecrawl).

## Build and run from source

Needs macOS on Apple silicon, Node 24, a Swift toolchain (Xcode, or swift.org's toolchain in `~/Library/Developer/Toolchains`), and Claude Code or Codex installed and signed in.

```sh
npm install
npm run electron:dev     # the app with live reload
npm run check            # typecheck, lint, tests
npm run dist:unsigned    # a packaged app in dist/mac-arm64/
```

A build from source shows as "mlch dev", keeps its own settings and saved keys, and never updates itself (official builds update from mlch.app). macOS asks you to allow an unsigned app the first time.

Forks: set your own update feed with `MLCH_UPDATE_URL`, your own sharing server in Settings, and your own source link with `MLCH_SOURCE_URL` when building `cloud/`.

## Run your own sharing server

Shared links can live on your own Cloudflare account instead of mlch.app: [mlch.app/server](https://mlch.app/server) has the steps (`npm run deploy:own` in `cloud/`). Details and the API: [cloud/README.md](cloud/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security problems: [SECURITY.md](SECURITY.md), privately please.
