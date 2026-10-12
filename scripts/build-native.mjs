#!/usr/bin/env node
// Builds the native helper (native/mlch-audio) in release mode.
//
//   node scripts/build-native.mjs [--test] [--debug]
//
// Uses a swift.org toolchain from ~/Library/Developer/Toolchains when there is
// one (the Command Line Tools' own compiler can mismatch its SDK), with the
// newest macOS SDK found; otherwise `xcrun swift`. Prints the binary's path.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = path.join(root, "native", "mlch-audio");
const args = process.argv.slice(2);
const config = args.includes("--debug") ? "debug" : "release";

function newest(dir, pattern) {
  try {
    return fs.readdirSync(dir).filter((name) => pattern.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  } catch {
    return undefined;
  }
}

function toolchain() {
  if (process.env.MLCH_SWIFT) return { swift: process.env.MLCH_SWIFT, env: {} };
  const dir = path.join(os.homedir(), "Library", "Developer", "Toolchains");
  const name = newest(dir, /^swift-[\d.]+-RELEASE\.xctoolchain$/);
  if (name) {
    const sdkDir = "/Library/Developer/CommandLineTools/SDKs";
    const sdk = newest(sdkDir, /^MacOSX\d+(\.\d+)?\.sdk$/);
    return {
      swift: path.join(dir, name, "usr", "bin", "swift"),
      env: sdk ? { SDKROOT: path.join(sdkDir, sdk) } : {},
    };
  }
  return { swift: execFileSync("xcrun", ["--find", "swift"], { encoding: "utf8" }).trim(), env: {} };
}

const { swift, env } = toolchain();
const run = (sub, extra = []) => {
  const result = spawnSync(swift, [sub, "--package-path", pkg, "-c", config, ...extra], { stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("build", ["--product", "mlch-audio"]);
if (args.includes("--test")) run("test");
console.log(path.join(pkg, ".build", config, "mlch-audio"));
