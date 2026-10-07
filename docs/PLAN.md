# mlch V1 plan

Status 2026-10-07: M0–M7 built, plus images, artifacts and the maker lane, media generation, search and research, logging. Next: George tests with real voice and real mulches.

## Decisions

| Topic | Decision |
|---|---|
| Audience | Personal use first. Unsigned local build. Signing, notarization and auto-update come later. |
| Shell | Next.js app inside Electron, built from node-banana's shell. Web version later. |
| AI | The user's own Claude Code or Codex subscription through node-banana's agent harness. Claude is the primary target; Codex stays supported because the harness already handles it. |
| Voice | Groq Whisper (user's key) behind a `Transcriber` interface. Local Parakeet comes later as a second implementation. |
| Live mode | Two speeds. Fast lane: key points appear within seconds of a pause. Slow lane: enrichment (search, definitions, examples, questions, connections) arrives after. |
| Sharing | Deferred past V1. Storage is designed so a snapshot plus its docs can be exported or uploaded later. |
| Run mode | `npm run app` (production build in Electron). Packaged, signed .app later. |
| Canvas | React Flow (`@xyflow/react` 12), as both reference projects use. |
| Web search | Claude's own `WebSearch` / `WebFetch` tools through the subscription. Firecrawl is an optional key for scraping and document parsing. |

## What we take from each project

### node-banana (MIT, © William Falloon; keep the notice in `THIRD_PARTY_NOTICES.md` and file headers)

- `electron/main.cjs`, `server.cjs`, `preload.cjs`, `lib/backend.cjs`, `runtime.cjs`, `env.cjs`, `files.cjs`, `credentials.cjs`, `bridge*.cjs`, `diagnostics.cjs`, `menu.cjs`, `window-state.cjs`, `recovery.cjs`. Rename, and add `media` (microphone) to the permission allowlist.
- `server.js` (loopback-only dev server with cross-site and DNS-rebinding guard).
- `scripts/package-electron.cjs` (keep for later signed builds; use the unsigned path now).
- `src/lib/agent/server/*`: `claudeHarness.ts`, `codexHarness.ts`, `codexAppServer.ts`, `billing.ts`, `env.ts`, `binaries.ts`, `chatStream.ts`, `sameOrigin.ts`, `claudeSignIn.ts`, `claudeStatus.ts`, `codexStatus.ts`, `toolExecution.ts`, `asyncQueue.ts`. Replace workflow tools with mulch tools.
- The pattern: tools edit a server-side draft, stream graph ops to the client, and each tool call becomes one undo step (`graph/applyOps.ts`, `graph/draft.ts`).
- `src/store/undoHistory.ts` (`UndoManager`).
- `next.config.shared.cjs` (`serverExternalPackages` for the agent SDKs).

Not taken: `workflowStore.ts`, `WorkflowCanvas.tsx`, node types, media providers, asset library.

### briefbuster (own code)

- `shared/board-doc.ts`: flat `id → entry` doc model, measured sizes written back, `freeSlot` / `dealPosition` placement shared by client and server.
- `worker/src/agent/arrange.ts`, `spatialDigest()`, `protectBrief()`-style refusal messages that state legal coordinates.
- `docs/TIMETRAVEL.md` design: idea ledger plus content-hashed checkpoints, `pre-restore` checkpoints.
- Agent loop rules from `loop.ts`: ceilings, wind-down with a forced reply, transcript persistence, repairing orphaned tool calls.
- Prompts: layout rules (top-left coordinates, never assume heights, read the canvas before referencing it), the `digestDoc` digest prompt, divergent by default.
- `parse.ts` / `links.ts` fallback chain, adapted to run locally.

Not taken: anything tied to Cloudflare, auth, billing, cards corpus, OpenRouter transport, `CanvasBoard.tsx` as a whole.

### Lessons applied

1. The LLM decides grouping and relations; deterministic code decides geometry.
2. The AI never moves or edits an item the user created or moved, unless the user asks.
3. Agent work runs in the backend process, independent of the window, and resumes after restart.
4. Error messages returned to the agent state what is allowed, not just what failed.
5. The agent gets structured canvas state (bounds, clusters, overlaps), not only a picture.
6. Validate fetched content, not just HTTP status (bot walls return 200).
7. Watch for "canvas fills itself and I disengage": the fast lane only adds what was said; enrichment is visually secondary and can be paused.

## Architecture

```
Electron main ── window (renderer: Next pages, React Flow canvas, mic capture)
     │
     └─ utilityProcess: Next server (API routes)
            ├─ mulch store (files on disk)
            ├─ transcription (Groq)
            ├─ agent harness (claude-agent-sdk / codex app-server, user's login)
            ├─ job queue: fast lane, slow lane, commands, ingest
            └─ event stream to renderer (SSE): graph ops, transcript, job status
```

### Storage

Each mulch is a plain folder, so Claude Code and other tools can read it directly and a later share or export is a copy of a slice of it.

```
~/Documents/mulch/<mulch-id>/
  mulch.json            current board: meta, nodes, edges
  transcript.jsonl       speech segments with timestamps
  events.jsonl           append-only op log (who, when, which op)
  history/<ts>.json.gz   checkpoints (content-hash deduped)
  assets/<sha256>.<ext>  dropped files, content-addressed
  assets/<sha256>.md     extracted text / digest per asset
  docs/<slug>.md         write-ups produced by the AI
  jobs.json              pending and running jobs (for resume)
```

Writes go through `atomicWrite`. The list of mulches is the list of folders.

### Board model

Adapted from `board-doc.ts`. Node kinds:

- `idea`: a point from speech or typing
- `question`: post-it with an open question
- `search`: web result (title, url, summary, fetched text kept)
- `definition`
- `example`
- `doc`: dropped file (preview + extracted text)
- `link`: dropped URL (extract kept, survives link rot)
- `image`
- `writeup`: markdown produced by the AI, opens in a side panel
- `group`: labelled region

Every node carries `origin` (`user` | `speech:<segmentId>` | `agent:<jobId>`), `userTouched` (set when the user creates, moves or edits it), and `createdAt`. Edges carry an optional label and `origin`.

### Agent tools (mulch-specific)

`get_mulch` (structured state with `spatialDigest`), `add_nodes` (with `near` / `group` hints, never raw coordinates in the fast lane), `connect`, `update_node`, `remove_nodes`, `group` / `arrange` (LLM grouping → deterministic geometry), `write_doc`, `read_asset`, `reply` (status line shown on canvas). `WebSearch` / `WebFetch` are enabled only for slow-lane and command jobs. For folder ingestion, read-only `Read` / `Glob` / `Grep` are scoped to the chosen folder.

### Live pipeline

1. Renderer captures the mic (`MediaRecorder`), cuts chunks on silence or at about 10 s, and posts them to `/api/transcribe`.
2. Server sends each chunk to Groq (`whisper-large-v3-turbo`), appends a segment to `transcript.jsonl`, and streams it back as a live transcript strip.
3. **Fast lane:** one serialized job per mulch batches the new segments. The model either extracts ideas and connections (`add_nodes`, `connect`, no web tools) or recognises a command and hands it to the command lane. To avoid cold-start latency per turn, keep one long-lived Claude session per open mulch (SDK streaming input / `resume`).
4. **Slow lane:** for each new batch of ideas, an enrichment job with web tools adds search results, definitions, examples, questions and cross-links. Limited concurrency, pausable, budgeted per mulch.
5. **Commands** ("organize this", "clean up", "write a summary"): a separate job with full tools. Write-ups land as `writeup` nodes and files in `docs/`.

Model per lane is configurable (fast: small model; slow and commands: larger).

### Ingestion

- Files dropped on the canvas: copied to `assets/`, text extracted locally (pdf via `unpdf`, docx via `mammoth`, md/txt as is, images described by the model). Firecrawl `/v2/parse` is used when a key is set.
- URLs: `WebFetch` through the agent, or Firecrawl when a key is set. Content is validated before use.
- After extraction, an ingest job digests the content (briefbuster `digestDoc` prompt) and places nodes linked to the source.
- Folder: native picker → an agent job with read-only file tools explores the folder and builds a mulch. Files it references are copied into `assets/`.

### History

- Every op is appended to `events.jsonl`.
- A checkpoint is written after each agent job and at most every 60 s of user edits, skipped if the content hash is unchanged.
- Timeline slider shows checkpoints read-only. Restore writes a `pre-restore` checkpoint first.
- Undo/redo (`UndoManager`) is separate and session-local.

### Keys and settings

Settings screen: Claude / Codex sign-in status (node-banana flows), Groq key, Firecrawl key (optional), model per lane. Keys are stored with `safeStorage` in main and handed to the server process over the bridge, not through renderer request headers.

## Milestones

Each milestone ends with something usable and tested (Vitest for logic; Playwright smoke run against Electron for the shell).

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold: Next 16 + Electron shell from node-banana, renamed, mic permission, `THIRD_PARTY_NOTICES.md`, Vitest, lint, `npm run dev` / `npm run electron:dev` | App window opens on an empty home screen |
| M1 | mlch list + canvas + storage: create/open/rename/delete mulches, React Flow canvas with node kinds, manual add/edit/move/connect, autosave to folder, undo | A hand-made mulch survives a restart |
| M2 | Agent harness: port Claude and Codex harnesses, settings screen, text box that sends input to the fast lane, graph ops streamed onto the canvas | Typing a paragraph produces idea nodes and connections live |
| M3 | Voice: `Transcriber` interface, Groq implementation, chunking, live transcript strip | Speaking produces the same result as typing |
| M4 | Slow lane enrichment: search, definitions, examples, questions, cross-links; pause control; per-mulch budget | Enrichment arrives after the fast lane without moving user items |
| M5 | Drops and folders: files, links, folder ingestion | Dropping a PDF, a URL, or picking a folder adds linked nodes |
| M6 | Commands and write-ups: organize, clean up, summarize; markdown side panel | "Write a summary" produces a `writeup` node and a `.md` file |
| M7 | History: checkpoints, timeline slider, restore | Can go back to any checkpoint and restore it |

Added after M7: the AI looks at images (view_image, dropped images are captioned); instructions can read files on the machine (read-only, private places refused); artifacts: HTML pages and decks shown over the canvas and checked by the agent with off-screen screenshots, and a maker lane that runs Claude Code or Codex with their own tools in their OS sandbox for PowerPoint, Word, PDF, spreadsheets and charts.

What comes next is tracked in [ROADMAP.md](ROADMAP.md).

## Risks and open items

- **Subscription limits.** Live mode uses many turns. Mitigation: batching, a small model in the fast lane, the slow lane budget, and the existing node-banana guard against overage.
- **Turn latency.** Spawning a Claude process per turn may take seconds. Mitigation: a long-lived session per mulch. Measure in M2 before building M3.
- **Command vs content.** Telling "organize this" apart from an idea that mentions organizing. Start with the fast-lane model classifying; add a held key or a spoken prefix if it misfires.
- **Distribution terms.** Anthropic restricts third-party apps from offering Claude subscription login. Check before distributing beyond personal use.
- **UI copy.** All on-screen text uses plain functional words; any sentence-level copy is supplied by George.
