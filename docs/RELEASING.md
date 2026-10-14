# Releasing the Mac app

`npm run release` does the building, signing, checking and uploading (scripts/release.mjs). This list is what goes around it.

## What has to be true

- The app is signed with Developer ID (hardened runtime), notarized and stapled.
- The DMG is signed, notarized and stapled too, so a download opens with one "downloaded from the internet" prompt and no lookup at Apple.
- The update zip unpacks to the same notarized app.
- `latest-mac.yml` goes up last, so no one sees a release before all of its files are there.

The release script refuses to upload anything unless Gatekeeper (`spctl`) accepts the app, the DMG and the app inside the zip as "Notarized Developer ID", and `stapler validate` passes for the app and the DMG.

## Before

1. All work is committed and pushed. `npm run check` passes.
2. Run the scenarios for what changed (`node scripts/electron-run.cjs scripts/scenarios/<name>.cjs`).
3. The tested Claude Code and Codex versions are the ones in package-lock.json (`@anthropic-ai/claude-agent-sdk`, `@openai/codex`). If you updated them, try one turn on each.
4. If media models are involved: `node scripts/fal-picks.mjs`.
5. Raise the version: `npm version <x.y.z> --no-git-tag-version`, plus the version in README.md. Commit as `<x.y.z>` and push.
6. Write the notes: one line on what changed, in plain words.

## Release

```
APPLE_KEYCHAIN_PROFILE=mlch npm run release -- --channel latest --notes "One line on what changed."
```

Use `--channel beta` first for anything risky, then `npm run release -- --promote` once it holds up.

The script checks, builds, notarizes the app, smoke-tests it, then signs, notarizes and staples the DMG. It runs the Gatekeeper checks, uploads to R2 (`releases/mac/`) and checks that mlch.app serves the new feed. Last, it tags `v<version>`, pushes the tag and makes the GitHub release with the DMG.

If an upload fails partway: `npm run release -- --upload-only`. It re-runs the Gatekeeper checks, then uploads, but makes no tag or GitHub release.

## After

1. Download from https://mlch.app/download in a browser, open the DMG, drag the app to Applications and open it. Expect one "downloaded from the internet" prompt, nothing else.
2. Check the download from the shell:
   `spctl -a -vv -t open --context context:primary-signature mlch-<x.y.z>-arm64.dmg` says accepted, Notarized Developer ID.
3. Open the previous version and let it update (it checks at start; reopen once if needed). After the restart, About shows the new version.
4. If the landing page or the Worker changed: in `cloud/`, `npm run deploy`.
5. Check the GitHub release page has the DMG and the notes.

## If something is wrong

- Never delete a release: the updater does not go back. Fix it with a newer version.
- Notarization refused: `xcrun notarytool log <id> --keychain-profile mlch` says why.
- One-time setup on a new Mac: the Developer ID certificate in the keychain, and `xcrun notarytool store-credentials mlch`.
