# npkn

Voice-first thinking canvas. Mac app: Next.js 16 inside Electron, AI on the user's own Claude Code / Codex subscription. Product vision: README.md. Plan and status: docs/PLAN.md.

## Commands

- `npm run check`: typecheck, lint, vitest, electron tests. Run before committing.
- `npm run dev`: browser dev server on :3100. Set `NPKN_LIBRARY=<dir>` to keep test napkins out of `~/Documents/npkn`.
- `npm run electron:dev` / `npm run app`: desktop app (dev / production build).
- `node scripts/electron-run.cjs <test.cjs> [--library dir] [--shots dir] [--fake-mic file.wav] [--production]`: drive the real app with Playwright (throwaway profile). `scripts/electron-shot.cjs <out.png> [route]` for a screenshot.

## Architecture

- `src/lib/napkin/`: the document. A napkin changes only through ops (`types.ts` NapkinOp), applied by the pure `ops.ts` on both sides. `store.ts` (server) holds open napkins, logs batches to `events.jsonl`, saves `napkin.json`, broadcasts over SSE. `client.ts` (browser) mirrors it, applies the user's ops optimistically, keeps undo (inverse ops). `place.ts` is all geometry. `history.ts` checkpoints.
- `src/lib/agent/`: `server/` is node-banana's harness (Claude Agent SDK, codex app-server, billing guard), kept close to upstream. `tools.ts` = napkin tools; `prompts.ts` = per-lane prompts; `jobs.ts` = per-napkin lanes (fast capture, slow enrichment, command, ingest).
- `src/lib/ingest/`: files and links into assets/ (content-addressed, extracted text beside them).
- `src/lib/voice/`: browser recorder (pause-cut WAV chunks) and server transcriber (Groq).
- `electron/`: shell adapted from node-banana. Main injects a per-launch token; keys live in Keychain via safeStorage and reach the server process over parentPort, never through the page.

## Rules

- UI copy: plain functional words only, no taglines or chatty lines. Ask George for any sentence-level wording.
- The AI never gives coordinates; it says `near`, `place.ts` decides. The LLM decides grouping, code decides geometry.
- The AI never edits, moves or removes what the person made, said or touched (origin `user` / `speech:*`, `userTouched`) unless an instruction allows it (`allowUserEdits`).
- Tool errors returned to the model say what is allowed, not just what failed.
- Every napkin change goes through ops so it is logged, undoable and in history.
- Dates shown with a time.
- Code adapted from node-banana keeps its MIT notice (THIRD_PARTY_NOTICES.md and file headers).
