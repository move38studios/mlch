# Contributing

mlch is an early release. Issues and pull requests are welcome.

- Read CLAUDE.md first: it describes the architecture, the design rules and the conventions (every canvas change goes through ops; the AI never gives coordinates; UI wording is plain and functional).
- Run `npm run check` (and `npm run check` in `cloud/` for server changes) before sending a change. The app scenarios in `scripts/scenarios/` drive the real app: `node scripts/electron-run.cjs scripts/scenarios/<name>.cjs --library <empty folder>`.
- Keep changes small and focused; say what you checked.
- Code adapted from node-banana keeps its MIT notice (THIRD_PARTY_NOTICES.md).
