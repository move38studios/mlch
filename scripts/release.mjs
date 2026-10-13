// Make and publish an official release of the Mac app (updates from mlch.app; builds from source never update).
//
//   APPLE_KEYCHAIN_PROFILE=mlch npm run release -- [--channel beta|latest] [--notes "One line on what changed."]
//   npm run release -- --promote          the current beta becomes latest (no rebuild)
//   npm run release -- --upload-only      publish what is already in dist/ (after a failed upload)
//
// Steps: refuses with uncommitted changes, an existing tag for this version, or a failing check; builds, signs and
// notarizes (npm run dist, official); smoke-tests the staged app; uploads the zip, its blockmap and the DMG to R2
// (bucket mlch-shares, releases/mac/), then <channel>-mac.yml last, so clients see a release only when it is complete;
// tags the commit (v<version>). The Worker serves releases/mac/ at https://mlch.app/releases/mac/.
// A bad release is undone by a newer version, never by deleting: electron-updater does not go back.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const channel = value("--channel") ?? "beta";
if (!["beta", "latest"].includes(channel)) throw new Error("--channel is beta or latest.");
const notes = value("--notes");

const run = (command, list, options = {}) => execFileSync(command, list, { cwd: root, stdio: "inherit", ...options });
const read = (command, list) => execFileSync(command, list, { cwd: root, encoding: "utf8" }).trim();
const r2 = (args) => run("npx", ["--no-install", "wrangler", "r2", "object", ...args, "--remote"], { cwd: path.join(root, "cloud") });
const put = (name, from = path.join(dist, name)) => {
  console.log(`uploading ${name}`);
  r2(["put", `mlch-shares/releases/mac/${name}`, "--file", from]);
};

if (flag("--promote")) {
  // The beta feed's file, as the latest feed: same zip, same version.
  const tmp = path.join(os.tmpdir(), `mlch-beta-${Date.now()}.yml`);
  r2(["get", "mlch-shares/releases/mac/beta-mac.yml", "--file", tmp]);
  const promoted = fs.readFileSync(tmp, "utf8").match(/version: (\S+)/)?.[1];
  // Its DMG becomes the one mlch.app's Download gives.
  const dmg = path.join(os.tmpdir(), `mlch-${promoted}.dmg`);
  r2(["get", `mlch-shares/releases/mac/mlch-${promoted}-arm64.dmg`, "--file", dmg]);
  put("mlch.dmg", dmg);
  put("latest-mac.yml", tmp);
  console.log("promoted", promoted, "to latest");
  process.exit(0);
}

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
if (!flag("--upload-only")) {
  if (read("git", ["status", "--porcelain"])) throw new Error("Uncommitted changes: commit first, so the release matches a commit.");
  if (read("git", ["tag", "--list", `v${version}`])) throw new Error(`v${version} is already released: raise the version in package.json.`);
  if (!process.env.APPLE_KEYCHAIN_PROFILE) throw new Error("Set APPLE_KEYCHAIN_PROFILE (xcrun notarytool store-credentials) so the release is notarized.");
  run("npm", ["run", "check"]);
  run("npm", ["run", "dist"], { env: { ...process.env, MLCH_OFFICIAL: "1" } });
  // The staged app, driven for real: it starts, makes a mulch and shows it.
  run("node", ["scripts/electron-run.cjs", "scripts/scenarios/empty-mulch.cjs", "--app", "build/app", "--library", fs.mkdtempSync(path.join(os.tmpdir(), "mlch-release-"))]);
}

const feed = path.join(dist, "latest-mac.yml");
if (!fs.existsSync(feed)) throw new Error("No dist/latest-mac.yml: build first (npm run dist).");
let yml = fs.readFileSync(feed, "utf8");
if (!yml.includes(`version: ${version}`)) throw new Error(`dist/ holds ${yml.match(/version: (\S+)/)?.[1]}, not ${version}.`);
if (notes) yml = `${yml.trimEnd()}\nreleaseNotes: ${JSON.stringify(notes)}\n`;
const files = [...new Set([...yml.matchAll(/(?:url|path): (\S+\.zip)/g)].map((m) => m[1]))];
for (const zip of files) {
  put(zip);
  if (fs.existsSync(path.join(dist, `${zip}.blockmap`))) put(`${zip}.blockmap`);
}
// The DMG for first installs (mlch.app's Download): versioned, and as the stable name the site links to.
const dmg = fs.readdirSync(dist).find((name) => name.endsWith(".dmg") && name.includes(version));
if (dmg) {
  put(dmg);
  if (channel === "latest") put("mlch.dmg", path.join(dist, dmg));
}
const out = path.join(dist, `${channel}-mac.yml`);
fs.writeFileSync(out, yml);
put(`${channel}-mac.yml`, out);
if (!flag("--upload-only")) run("git", ["tag", "-a", `v${version}`, "-m", `mlch ${version}${notes ? `: ${notes}` : ""}`]);
console.log(`released ${version} to ${channel}`);
