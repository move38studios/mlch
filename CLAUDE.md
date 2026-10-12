# mlch

**mlch is the app; mulch is the thing.** Everywhere the app's name shows (app and window name, menus, dialogs, folders like `~/Documents/mlch`, the domain mlch.app, the repo, `MLCH_*` env vars, `~/.mlch`, globals, headers, CSS class prefixes, the agent's MCP server) it is lowercase **mlch**, said "mulch". The thing you create is barely named in the interface ("New", titles, "This one / All"); in code it is a `Mulch` (`mulchId`, `/api/mulches`, `search_mulch`), and the agent calls it "the canvas".

Voice-first thinking canvas. Mac app: Next.js 16 inside Electron, AI on the user's own Claude Code / Codex subscription. Product vision: README.md. V1 plan and status: docs/PLAN.md. Current plan (call to shared link, with checks): docs/PLAN-2.md. What comes next: docs/ROADMAP.md (delete items when they ship). Investigations: docs/research/.

## Commands

- `npm run check`: typecheck, lint, vitest, electron tests. Run before committing.
- `npm run dev`: browser dev server on :3100. Set `MLCH_LIBRARY=<dir>` to keep test data out of `~/Documents/mlch`.
- `scripts/scenarios/*.cjs`: app scenarios for `electron-run` (checks from PLAN-2).
- `npm run electron:dev` / `npm run app`: desktop app (dev / production build).
- `node scripts/electron-run.cjs <test.cjs> [--library dir] [--shots dir] [--fake-mic file.wav] [--production]`: drive the real app with Playwright (throwaway profile). `scripts/electron-shot.cjs <out.png> [route]` for a screenshot. electron-run fails if a new Electron crash report appears in ~/Library/Logs/DiagnosticReports.

## Architecture

- `src/lib/mulch/`: the document. A mulch changes only through ops (`types.ts` MulchOp), applied by the pure `ops.ts` on both sides. `store.ts` (server) holds open mulches, logs batches to `events.jsonl`, saves `mulch.json`, broadcasts over SSE. `client.ts` (browser) mirrors it, applies the user's ops optimistically, keeps undo (inverse ops). `place.ts` is all geometry. `history.ts` checkpoints.
- `src/lib/agent/`: `server/` is node-banana's harness (Claude Agent SDK, codex app-server, billing guard), kept close to upstream. `tools.ts` = mulch tools; `prompts.ts` = per-lane prompts; `jobs.ts` = per-mulch lanes (fast capture, slow enrichment, quick instructions, ingest) plus long work (making, research: at most 2 per mulch, 3 in all). The person's instructions and long work are kept in `<mulch>/jobs.json` (unseen results, failures, retry; ones running at quit come back failed). A long job holds space on the canvas (`holdSpace` in place.ts) where its result lands and where the canvas draws it in progress. Main shows a notification when one finishes elsewhere, badges the Dock with unseen results, and asks before quitting while work runs.
- `src/lib/ingest/`: files and links into assets/ (content-addressed, extracted text beside them).
- Sharing: `cloud/` is the Cloudflare Worker on mlch.app (placeholder landing) and share.mlch.app (shared things on their own origin): capability links, no accounts, files in R2 served with the artifact sandbox, one Durable Object per shared canvas that numbers the owner's op batches and relays them to viewers (multi-writer later). The viewer reuses the app's canvas components read-only. `src/lib/share/client.ts` is the app's side (owner tokens stay server-side). API and deploy: cloud/README.md.
- `src/lib/artifacts/`: files the AI makes, in the mulch's `artifacts/`. HTML is served with a sandboxing CSP (opaque origin, no network) and shown full-window over the canvas; the agent checks it with `preview_artifact` (main renders it off-screen). `pptx.ts` is the quick template builder; real decks and documents come from the maker lane.
- Maker lane (`submitMake` in jobs.ts): Claude Code with its own tools inside its OS sandbox (`workspace` in HarnessTurnParams → `sandbox` + permission rules in claudeHarness.ts), or `codex exec` in workspace-write (codexExec.ts). Writes only to `<mulch>/work` and `<mulch>/artifacts`; network only to package registries (Claude). New files in artifacts/ become cards.
- `src/lib/search/`: one SQLite index for the library (`<library>/.index.sqlite`, `node:sqlite` with FTS5) plus local embeddings (multilingual-e5-small) in a WebAssembly worker thread (`scripts/embed-worker.mjs`, onnxruntime-web). Search merges keyword and vector rankings, never waits more than 8s on the model, and works keyword-only without it. `exa.ts` is the optional Exa web search.
- Research lane (`submitResearch` in jobs.ts): many searches and page reads, then sources, a comparison table and a write-up; resumes the session once if outputs are missing.
- Logging: `src/lib/log.ts` writes JSON lines to `<logs>/mulch.jsonl` (redacted, rotated); main writes `desktop.log` and records process crashes; crash dumps stay local. Settings → Diagnostics saves a support report to ~/Downloads.
- File reading for instructions: read-only, home folder, private places refused (`src/lib/agent/files.ts`).
- `src/lib/voice/`: browser recorder (pause-cut WAV chunks) and server transcriber (Groq, or local per Settings). `local.ts`: local transcription and system audio capture through the native helper (chunks become speech from "them"; the mic is "me" while one runs).
- `native/mlch-audio/`: Swift helper binary (Parakeet via FluidAudio on the Neural Engine; Core Audio process tap for the Mac's sound output), JSON lines over stdio, started by main (`electron/lib/audio-helper.cjs`, restarted once after a crash) and reached through the bridge's `audio` request. Build with `node scripts/build-native.mjs [--test]` (uses a swift.org toolchain from ~/Library/Developer/Toolchains when present). Model in ~/Library/Application Support/mlch/models.
- `electron/`: shell adapted from node-banana. Main injects a per-launch token; keys live in Keychain via safeStorage and reach the server process over parentPort, never through the page.

## Design

Black marker on a clean napkin, with one amber highlighter. Tokens live in `src/app/globals.css` (`:root`, exposed to Tailwind via `@theme`); use them, not raw colours.

- **Type:** Schibsted Grotesk for everything (`--font-ui`). The logo's hand lettering appears only as the wordmark (`public/brand/wordmark.svg`); Barriecito (`--font-scribble`) is loaded for it and used nowhere else. Sentence case, no all-caps labels, no middle dots between items.
- **Colour:** paper `#FCFCFA` (canvas), chrome white (cards, floating panels), ink pure black at three strengths (`ink`, `ink-2`, `ink-3`), hairlines (`line`, `line-2`). Amber `#FFC000` only as a fill, never text: New, recording, selection, focus pulse, things that need you. Tints for kinds: `amber-soft` the person's post-it notes, `blush` questions, `mist` definitions, `sage` examples. `danger` for errors and failures.
- **Cards:** the person's own words (origin `user` / `speech:*`, or touched) carry a 1.5px ink outline; AI material sits on a hairline or its tint. Typed notes are tilted yellow post-its. Kind labels are small, lowercase, `ink-3`. Selected: amber outline.
- **Connections:** soft cubic curves bowing to one side (`FloatingEdge.tsx`); the person's solid, the AI's dotted; labels on paper chips, shown only when they fit.
- **Chrome:** the canvas is full-bleed; controls float over it in white `.float` panels (hairline, soft shadow, rounded-xl/2xl). Primary buttons black, the one creative action amber.
- **The scribble** (from the logo, `components/brand/Scribble.tsx`) is the only animated motif: drawn while listening (moves only while you speak), looping wherever the AI is working (job control, placeholder card, mulch list), faint and still on an empty canvas. Nowhere else.
- **Motion:** only to show a change: cards entering, the focus pulse, the scribble. Respect reduced motion.
- `scripts/brand-assets.mjs` rebuilds the icon, wordmark and scribbles from `design/mlch-logo.svg`.

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
