// Assembles the packaged app's files in build/app, for electron-builder (electron-builder.yml).
//   node scripts/package-app.mjs [--skip-build]
//
// Only what runs goes in:
// - Next's standalone build (the server files it traces), its static files and public/;
// - Electron's side (main, preload, the server process) and the search worker, traced the same way;
// - the one WebAssembly runtime the search worker loads.
// Left out on purpose: Claude Code's and Codex's CLIs (downloaded on first use, src/lib/agent/server/cli.ts),
// the models (downloaded on first use), build tools, and onnxruntime's native build (crashes Electron).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const stage = path.join(root, "build", "app");
const require = createRequire(import.meta.url);
const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");

if (!process.argv.includes("--skip-build")) {
  execFileSync("npx", ["next", "build"], { cwd: root, stdio: "inherit", env: { ...process.env, MLCH_STANDALONE: "1" } });
}
const standalone = path.join(root, ".next", "standalone");
if (!fs.existsSync(path.join(standalone, ".next", "BUILD_ID"))) throw new Error("No standalone build in .next/standalone.");

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const copy = (from, to) => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, dereference: false });

// 1. The Next server as traced.
for (const name of [".next", "node_modules"]) copy(path.join(standalone, name), path.join(stage, name));
copy(path.join(root, ".next", "static"), path.join(stage, ".next", "static"));
copy(path.join(root, "public"), path.join(stage, "public"));
// Next's route runtimes, which its own trace can miss (route handlers failed without app-route-turbo).
const runtimes = path.join("node_modules", "next", "dist", "compiled", "next-server");
for (const name of fs.readdirSync(path.join(root, runtimes)).filter((n) => n.endsWith(".runtime.prod.js"))) {
  fs.copyFileSync(path.join(root, runtimes, name), path.join(stage, runtimes, name));
}

// 2. Electron's side and the search worker, with everything they load.
const entries = [
  "electron/main.cjs", "electron/preload.cjs", "electron/server.cjs", "scripts/embed-worker.mjs",
  "node_modules/@huggingface/transformers/dist/transformers.web.js",
  // External server packages whose own imports Next's trace can miss (the agent SDK's MCP server).
  ...fs.readdirSync(path.join(root, "node_modules/@anthropic-ai/claude-agent-sdk")).filter((name) => /\.m?js$/.test(name)).map((name) => `node_modules/@anthropic-ai/claude-agent-sdk/${name}`),
];
const { fileList } = await nodeFileTrace(entries.map((entry) => path.join(root, entry)), {
  base: root,
  processCwd: root,
  // Electron is the runtime itself; the CLIs and onnxruntime's native build are left out on purpose.
  ignore: (file) => /^node_modules\/(electron\/|onnxruntime-node|@openai\/codex|@anthropic-ai\/claude-agent-sdk-(darwin|linux|win32))/.test(file),
});
const extra = [
  // Loaded by onnxruntime-web at run time, by name.
  "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
  "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
  "electron/icon.png",
  ...fs.readdirSync(path.join(root, "electron")).filter((name) => name.endsWith(".png")).map((name) => `electron/${name}`),
];
let copied = 0;
for (const file of [...fileList, ...extra]) {
  // Next itself comes from the standalone build (only what production uses).
  if (/^next\.config/.test(file) || /^(dist|build|cloud|native|docs|src|\.next)\//.test(file) || /^node_modules\/(next|@next|@swc|styled-jsx|caniuse-lite)\//.test(file) || file.startsWith("node_modules/onnxruntime-node/") || /node_modules\/@(openai\/codex|anthropic-ai\/claude-agent-sdk)-(darwin|linux|win32)/.test(file)) continue;
  const from = path.join(root, file);
  if (!fs.existsSync(from) || fs.statSync(from).isDirectory()) continue;
  const to = path.join(stage, file);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied++;
}

// 3. The CLI versions mlch was tested with (src/lib/agent/server/cli.ts downloads these when the person has none as new).
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")).packages;
const CLIS = {
  claude: { key: "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64", binary: "package/claude", team: "Q6L2SF6YDW" },
  codex: { key: "node_modules/@openai/codex-darwin-arm64", binary: "package/vendor/aarch64-apple-darwin/bin/codex", team: "2DC432GLL2" },
};
const manifest = {};
for (const [id, cli] of Object.entries(CLIS)) {
  const entry = lock[cli.key];
  const installed = path.join(root, cli.key, cli.binary.replace(/^package\//, ""));
  const version = /(\d+\.\d+\.\d+)/.exec(execFileSync(installed, ["--version"], { encoding: "utf8" }))?.[1];
  if (!entry || !version) throw new Error(`Cannot pin ${id}: run npm install.`);
  manifest[id] = { version, tarball: entry.resolved, integrity: entry.integrity, binary: cli.binary, team: cli.team };
}
fs.writeFileSync(path.join(stage, "cli.json"), JSON.stringify(manifest, null, 2));

// 4. The app's package.json: what Electron starts, and the version updates compare.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, author: pkg.author, main: pkg.main }, null, 2));

const size = execFileSync("du", ["-sh", stage], { encoding: "utf8" }).split("\t")[0];
console.log(`build/app: ${size} (${copied} files traced beside the Next server)`);
