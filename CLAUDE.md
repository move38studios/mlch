# Mulch

In the interface the product is **Mulch** and the thing you create is barely named ("New", titles, "This one / All"); where a noun is needed it is "a mulch". In code it is a `Mulch` (types, store, routes, tools); the agent calls it "the canvas".

Spelling: people see and say **Mulch** (app name, window, menus, `~/Documents/Mulch`). The handle is **mlch**: domain mlch.app, this folder and the repo, the bundle id (`app.mlch.mac` when packaged), social handles. Internal identifiers stay `mulch` (`MULCH_*`, `~/.mulch`).

Voice-first thinking canvas. Mac app: Next.js 16 inside Electron, AI on the user's own Claude Code / Codex subscription. Product vision: README.md. Plan and status: docs/PLAN.md.

## Commands

- `npm run check`: typecheck, lint, vitest, electron tests. Run before committing.
- `npm run dev`: browser dev server on :3100. Set `MULCH_LIBRARY=<dir>` to keep test data out of `~/Documents/Mulch`.
- `npm run electron:dev` / `npm run app`: desktop app (dev / production build).
- `node scripts/electron-run.cjs <test.cjs> [--library dir] [--shots dir] [--fake-mic file.wav] [--production]`: drive the real app with Playwright (throwaway profile). `scripts/electron-shot.cjs <out.png> [route]` for a screenshot. electron-run fails if a new Electron crash report appears in ~/Library/Logs/DiagnosticReports.

## Architecture

- `src/lib/mulch/`: the document. A mulch changes only through ops (`types.ts` MulchOp), applied by the pure `ops.ts` on both sides. `store.ts` (server) holds open mulches, logs batches to `events.jsonl`, saves `mulch.json`, broadcasts over SSE. `client.ts` (browser) mirrors it, applies the user's ops optimistically, keeps undo (inverse ops). `place.ts` is all geometry. `history.ts` checkpoints.
- `src/lib/agent/`: `server/` is node-banana's harness (Claude Agent SDK, codex app-server, billing guard), kept close to upstream. `tools.ts` = mulch tools; `prompts.ts` = per-lane prompts; `jobs.ts` = per-mulch lanes (fast capture, slow enrichment, command, ingest).
- `src/lib/ingest/`: files and links into assets/ (content-addressed, extracted text beside them).
- `src/lib/artifacts/`: files the AI makes, in the mulch's `artifacts/`. HTML is served with a sandboxing CSP (opaque origin, no network) and shown full-window over the canvas; the agent checks it with `preview_artifact` (main renders it off-screen). `pptx.ts` is the quick template builder; real decks and documents come from the maker lane.
- Maker lane (`submitMake` in jobs.ts): Claude Code with its own tools inside its OS sandbox (`workspace` in HarnessTurnParams → `sandbox` + permission rules in claudeHarness.ts), or `codex exec` in workspace-write (codexExec.ts). Writes only to `<mulch>/work` and `<mulch>/artifacts`; network only to package registries (Claude). New files in artifacts/ become cards.
- `src/lib/search/`: one SQLite index for the library (`<library>/.index.sqlite`, `node:sqlite` with FTS5) plus local embeddings (multilingual-e5-small) in a WebAssembly worker thread (`scripts/embed-worker.mjs`, onnxruntime-web). Search merges keyword and vector rankings, never waits more than 8s on the model, and works keyword-only without it. `exa.ts` is the optional Exa web search.
- Research lane (`submitResearch` in jobs.ts): many searches and page reads, then sources, a comparison table and a write-up; resumes the session once if outputs are missing.
- Logging: `src/lib/log.ts` writes JSON lines to `<logs>/mulch.jsonl` (redacted, rotated); main writes `desktop.log` and records process crashes; crash dumps stay local. Settings → Diagnostics saves a support report to ~/Downloads.
- File reading for instructions: read-only, home folder, private places refused (`src/lib/agent/files.ts`).
- `src/lib/voice/`: browser recorder (pause-cut WAV chunks) and server transcriber (Groq).
- `electron/`: shell adapted from node-banana. Main injects a per-launch token; keys live in Keychain via safeStorage and reach the server process over parentPort, never through the page.

## Rules

- UI copy: plain functional words only, no taglines or chatty lines. Ask George for any sentence-level wording.
- The AI never gives coordinates; it says `near`, `place.ts` decides. The LLM decides grouping, code decides geometry.
- The AI never edits, moves or removes what the person made, said or touched (origin `user` / `speech:*`, `userTouched`) unless an instruction allows it (`allowUserEdits`).
- Tool errors returned to the model say what is allowed, not just what failed.
- Every mulch change goes through ops so it is logged, undoable and in history.
- Dates shown with a time.
- No native ML runtimes inside Electron processes (onnxruntime-node crashes them with EXC_BREAKPOINT); use WebAssembly. Built-ins the bundler does not know (`node:sqlite`, `node:worker_threads` with a file) are loaded with `process.getBuiltinModule`.
- Log with `log.info/warn/error(area, msg, { mulchId, jobId, … })`, not console.
- Never give the agent an unsandboxed shell. Native tools only through `workspace` (OS sandbox).
- Anything the AI generates and the app renders (HTML artifacts) is untrusted: sandboxed origin, no network, no navigation. The desktop server refuses API requests from foreign pages.
- Code adapted from node-banana keeps its MIT notice (THIRD_PARTY_NOTICES.md and file headers).
