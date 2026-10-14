// Make and publish an official release of the Mac app (updates from mlch.app; builds from source never update).
//
//   APPLE_KEYCHAIN_PROFILE=mlch npm run release -- [--channel beta|latest] [--notes "One line on what changed."]
//   npm run release -- --promote          the current beta becomes latest (no rebuild)
//   npm run release -- --upload-only      publish what is already in dist/ (after a failed upload)
//
// Steps: refuses with uncommitted changes, an existing tag for this version, or a failing check; builds, signs and
// notarizes the app (npm run dist, official); smoke-tests the staged app; signs, notarizes and staples the DMG too;
// checks with Gatekeeper that the app, the DMG and the app inside the update zip are notarized (nothing is uploaded
// otherwise); uploads the zip, its blockmap and the DMG to R2 (bucket mlch-shares, releases/mac/), then
// <channel>-mac.yml last, so clients see a release only when it is complete; checks the feed mlch.app serves; tags the
// commit (v<version>), pushes the tag and makes the GitHub release with the DMG. The Worker serves releases/mac/ at
// https://mlch.app/releases/mac/. The checklist around it: docs/RELEASING.md.
// A bad release is undone by a newer version, never by deleting: electron-updater does not go back.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
/** Gatekeeper's verdict on a file, with its source line (spctl writes both to stderr). */
const assessed = (list) => execFileSync("sh", ["-c", 'spctl "$@" 2>&1 || true', "spctl", ...list], { encoding: "utf8" });
const IDENTITY = "Developer ID Application: move38 B.V. (FP3X7G6BU7)";
// mlch.app's config (its Cloudflare account and bucket), not an own server's.
const r2 = (args) => run("npx", ["--no-install", "wrangler", "r2", "object", ...args, "--remote", "-c", "wrangler.mlch.jsonc"], { cwd: path.join(root, "cloud") });
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
// The commit this release is built from (tagged at the end, even if work goes on meanwhile).
const commit = read("git", ["rev-parse", "HEAD"]);
if (!flag("--upload-only")) {
  if (read("git", ["status", "--porcelain"])) throw new Error("Uncommitted changes: commit first, so the release matches a commit.");
  if (read("git", ["tag", "--list", `v${version}`])) throw new Error(`v${version} is already released: raise the version in package.json.`);
  if (!process.env.APPLE_KEYCHAIN_PROFILE) throw new Error("Set APPLE_KEYCHAIN_PROFILE (xcrun notarytool store-credentials) so the release is notarized.");
  run("npm", ["run", "check"]);
  run("npm", ["run", "dist"], { env: { ...process.env, MLCH_OFFICIAL: "1" } });
  // The staged app, driven for real: it starts, makes a mulch and shows it.
  run("node", ["scripts/electron-run.cjs", "scripts/scenarios/empty-mulch.cjs", "--app", "build/app", "--library", fs.mkdtempSync(path.join(os.tmpdir(), "mlch-release-"))]);
  // The DMG as well as the app inside it: signed, notarized and stapled, so a download opens with no lookup at Apple.
  const image = path.join(dist, `mlch-${version}-arm64.dmg`);
  if (!fs.existsSync(image)) throw new Error(`No ${path.basename(image)} in dist/.`);
  run("codesign", ["--sign", IDENTITY, "--timestamp", "--force", image]);
  const submitted = JSON.parse(read("xcrun", ["notarytool", "submit", image, "--keychain-profile", process.env.APPLE_KEYCHAIN_PROFILE, "--wait", "--output-format", "json"]));
  if (submitted.status !== "Accepted") throw new Error(`The DMG was not notarized (${submitted.status}): xcrun notarytool log ${submitted.id} --keychain-profile ${process.env.APPLE_KEYCHAIN_PROFILE}`);
  run("xcrun", ["stapler", "staple", image]);
  // Stapling changed the DMG: the feed lists it with its new hash and size.
  const bytes = fs.readFileSync(image);
  const feedFile = path.join(dist, "latest-mac.yml");
  const listed = fs.readFileSync(feedFile, "utf8").replace(
    new RegExp(`(- url: ${path.basename(image).replace(/\./g, "\\.")}\\n\\s+sha512: )\\S+(\\n\\s+size: )\\d+`),
    (_all, before, between) => `${before}${createHash("sha512").update(bytes).digest("base64")}${between}${bytes.length}`,
  );
  if (!listed.includes(`size: ${bytes.length}`)) throw new Error("The DMG's entry in latest-mac.yml was not updated after stapling.");
  fs.writeFileSync(feedFile, listed);
}

// Nothing goes up unless Gatekeeper accepts all three: the app, the DMG, and the app the update zip unpacks to.
{
  const failures = [];
  const expect = (what, verdict) => {
    console.log(`${what}: ${verdict.trim().replace(/\n/g, ", ")}`);
    if (!/accepted/.test(verdict) || !/Notarized Developer ID/.test(verdict)) failures.push(what);
  };
  const staple = (what, file) => {
    try {
      execFileSync("xcrun", ["stapler", "validate", file], { stdio: "ignore" });
    } catch {
      failures.push(`${what} (no stapled ticket)`);
    }
  };
  const app = path.join(dist, "mac-arm64", "mlch.app");
  const image = path.join(dist, `mlch-${version}-arm64.dmg`);
  const zip = path.join(dist, `mlch-${version}-arm64-mac.zip`);
  expect("app", assessed(["-a", "-vv", "-t", "exec", app]));
  staple("app", app);
  expect("dmg", assessed(["-a", "-vv", "-t", "open", "--context", "context:primary-signature", image]));
  staple("dmg", image);
  const unzipped = fs.mkdtempSync(path.join(os.tmpdir(), "mlch-zip-"));
  run("ditto", ["-x", "-k", zip, unzipped]);
  expect("update zip", assessed(["-a", "-vv", "-t", "exec", path.join(unzipped, "mlch.app")]));
  if (failures.length) throw new Error(`Not released, Gatekeeper refused: ${failures.join(", ")}.`);
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
// What clients will read now.
const served = await fetch(`https://mlch.app/releases/mac/${channel}-mac.yml`, { cache: "no-store" }).then((r) => r.text());
if (!served.includes(`version: ${version}`)) throw new Error(`mlch.app still serves ${served.match(/version: (\S+)/)?.[1]} on ${channel}.`);
if (!flag("--upload-only")) {
  run("git", ["tag", "-a", `v${version}`, commit, "-m", `mlch ${version}${notes ? `: ${notes}` : ""}`]);
  run("git", ["push", "origin", `v${version}`]);
  if (dmg) {
    const body = `${notes ? `${notes} ` : ""}macOS 14.4 or later, Apple silicon. Signed and notarized. Also at https://mlch.app`;
    run("gh", ["release", "create", `v${version}`, path.join(dist, dmg), "--title", `mlch ${version}`, "--notes", body, ...(channel === "beta" ? ["--prerelease"] : [])]);
  }
}
console.log(`released ${version} to ${channel}`);
