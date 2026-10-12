// Builds cloud/dist: the landing page, the brand files and the viewer.
// The viewer is built with the app's own Vite and dependencies (repo root).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(cloud, "..");
const dist = path.join(cloud, "dist");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
const built = spawnSync(process.execPath, [vite, "build", "--config", path.join(cloud, "viewer", "vite.config.ts"), "--logLevel", "warn"], { cwd: root, stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);

fs.copyFileSync(path.join(cloud, "landing", "index.html"), path.join(dist, "index.html"));
fs.cpSync(path.join(root, "public", "brand"), path.join(dist, "brand"), { recursive: true });
console.log("Built", path.relative(root, dist));
