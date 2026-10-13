// Your own mlch server on your Cloudflare account: creates the storage,
// builds, deploys (wrangler.jsonc), and the first time makes the server key.
// Prints the address and key to enter in mlch (Settings, Sharing).
//
//   cd cloud && npx wrangler login && npm run deploy:own
//
// The key is kept in cloud/.server-key (not committed) so a later run can show it again.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(cloud, "node_modules", "wrangler", "bin", "wrangler.js");
const keyFile = path.join(cloud, ".server-key");

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [wrangler, ...args], { cwd: cloud, encoding: "utf8", ...options });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}
function stop(message, detail = "") {
  console.error(`\n${message}\n${detail}`);
  process.exit(1);
}

const who = run(["whoami"]);
if (!who.ok || /not authenticated/i.test(who.out)) stop("Log in to Cloudflare first: npx wrangler login");

const bucket = run(["r2", "bucket", "create", "mlch-server-shares"]);
if (!bucket.ok && !/already exists|already own/i.test(bucket.out)) stop("Could not create the storage (R2). R2 may need to be turned on in the Cloudflare dashboard first.", bucket.out);

const build = spawnSync("npm", ["run", "build"], { cwd: cloud, stdio: "inherit" });
if (build.status !== 0) stop("The build failed. Run npm install in the repository folder and in cloud/ first.");

const deploy = run(["deploy"]);
if (!deploy.ok) stop("Deploying failed.", deploy.out);
const address = /https:\/\/[\w.-]+\.workers\.dev/.exec(deploy.out)?.[0];

let key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : "";
if (!key) {
  key = randomBytes(24).toString("base64url");
  const secret = run(["secret", "put", "SERVER_KEY"], { input: key });
  if (!secret.ok) stop("Could not set the server key.", secret.out);
  fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
}

console.log(`
Your mlch server is running.

In mlch: Settings, Sharing, Your own server. Enter:
  Address  ${address ?? "(the workers.dev address shown above)"}
  Key      ${key}
`);
