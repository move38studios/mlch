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

// The landing page is the canvas built beside the viewer; Cloudflare Web Analytics' beacon when a token is set (landing/analytics.txt).
const tokenFile = path.join(cloud, "landing", "analytics.txt");
const analytics = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
const landing = fs.readFileSync(path.join(dist, "viewer", "landing.html"), "utf8").replace(
  "<!--ANALYTICS-->",
  analytics ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='${JSON.stringify({ token: analytics })}'></script>` : "",
);
fs.writeFileSync(path.join(dist, "index.html"), landing);
fs.rmSync(path.join(dist, "viewer", "landing.html"));
fs.mkdirSync(path.join(dist, "server"));
fs.copyFileSync(path.join(cloud, "landing", "server.html"), path.join(dist, "server", "index.html"));
// Legal pages (/privacy, /terms, /refunds, /company), the admin page (/admin), and their stylesheet.
fs.copyFileSync(path.join(cloud, "landing", "site.css"), path.join(dist, "site.css"));
for (const name of ["privacy", "terms", "refunds", "company"]) {
  fs.mkdirSync(path.join(dist, name));
  fs.copyFileSync(path.join(cloud, "landing", "legal", `${name}.html`), path.join(dist, name, "index.html"));
}
fs.cpSync(path.join(cloud, "landing", "admin"), path.join(dist, "admin"), { recursive: true });
fs.cpSync(path.join(root, "public", "brand"), path.join(dist, "brand"), { recursive: true });
// The other site pages (legal, own-server guide) count too; never the admin page or shared things.
if (analytics) {
  for (const page of ["privacy", "terms", "refunds", "company", "server"]) {
    const file = path.join(dist, page, "index.html");
    const html = fs.readFileSync(file, "utf8");
    if (!html.includes("cloudflareinsights")) fs.writeFileSync(file, html.replace("</body>", `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='${JSON.stringify({ token: analytics })}'></script>\n</body>`));
  }
}
console.log("Built", path.relative(root, dist));
