// Publish a built release to mlch.app for auto-update (electron-updater, generic provider).
// After `APPLE_KEYCHAIN_PROFILE=mlch npm run dist` (signed and notarized), run: node scripts/release.mjs
// Uploads dist/latest-mac.yml, the zip and its blockmap to R2 (bucket mlch-shares, releases/mac/),
// which the Worker serves at https://mlch.app/releases/mac/. The .yml goes last, so clients see a release only when it is complete.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const feed = path.join(dist, "latest-mac.yml");
if (!fs.existsSync(feed)) throw new Error("No dist/latest-mac.yml: build first (npm run dist).");
const yml = fs.readFileSync(feed, "utf8");
const files = [...new Set([...yml.matchAll(/(?:url|path): (\S+\.zip)/g)].map((m) => m[1]))];
const put = (name) => {
  console.log(`uploading ${name}`);
  execFileSync("npx", ["--no-install", "wrangler", "r2", "object", "put", `mlch-shares/releases/mac/${name}`, "--file", path.join(dist, name), "--remote"], { cwd: path.join(root, "cloud"), stdio: "inherit" });
};
for (const zip of files) {
  put(zip);
  if (fs.existsSync(path.join(dist, `${zip}.blockmap`))) put(`${zip}.blockmap`);
}
put("latest-mac.yml");
console.log("released", yml.match(/version: (\S+)/)?.[1]);
