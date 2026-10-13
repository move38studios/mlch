# Contributing

Issues and pull requests are welcome.

- CLAUDE.md describes the architecture and the conventions the code follows.
- Run `npm run check` before sending a change, and `npm run check` in `cloud/` if you changed the server.
- `scripts/scenarios/` has tests that drive the real app: `node scripts/electron-run.cjs scripts/scenarios/<name>.cjs`.
