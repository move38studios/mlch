/**
 * Claude Code and Codex for the packaged app, which ships neither. Server-only.
 *
 * For each CLI mlch knows the version it was tested with (cli.json beside the
 * packaged app, or package-lock.json in development). It uses:
 * 1. the person's own install, found in the usual places, when it is at least
 *    that version and has not failed in mlch (a newer install brings its
 *    improvements without an mlch release);
 * 2. otherwise that exact version, downloaded once from the npm registry into
 *    Application Support, checked against the lockfile's hash and the maker's
 *    Apple signature (Anthropic, OpenAI) before it is used.
 *
 * Lookups are synchronous (binaries.ts); the first one starts the work in the
 * background and reports "getting ready" until it is done.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { log } from "@/lib/log";

const run = promisify(execFile);

export type CliId = "claude" | "codex";

export interface PinnedCli {
  /** The binary's own version (`--version`). */
  version: string;
  tarball: string;
  integrity: string;
  /** The binary inside the extracted package. */
  binary: string;
  /** Apple Team ID the binary must be signed with. */
  team: string;
}

export interface CliChoice {
  path: string;
  source: "installed" | "downloaded";
  version: string;
}

export interface CliState {
  /** "missing": no usable install, and the download was not asked for (only the AI in use is downloaded). */
  state: "checking" | "missing" | "downloading" | "ready" | "failed";
  progress?: number;
  error?: string;
}

const PACKAGES: Record<CliId, { lockKey: string; binary: string; team: string; name: string }> = {
  claude: { lockKey: "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64", binary: "package/claude", team: "Q6L2SF6YDW", name: "claude" },
  codex: { lockKey: "node_modules/@openai/codex-darwin-arm64", binary: "package/vendor/aarch64-apple-darwin/bin/codex", team: "2DC432GLL2", name: "codex" },
};

interface State {
  choices: Map<CliId, CliChoice>;
  status: Map<CliId, CliState>;
  preparing: Map<CliId, Promise<CliChoice | undefined>>;
  /** Installed binaries that failed in mlch ("path@version"): not used again this run. */
  bad: Set<string>;
}
const globalState = globalThis as typeof globalThis & { __mlchCli?: State };
function state(): State {
  return (globalState.__mlchCli ??= { choices: new Map(), status: new Map(), preparing: new Map(), bad: new Set() });
}

/* ── versions ──────────────────────────────────────────────────── */

export function parseVersion(text: string): number[] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

export function atLeast(version: string, minimum: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

let pinnedCache: Record<CliId, PinnedCli> | undefined;

/** The tested versions: cli.json in the packaged app (written by scripts/package-app.mjs). */
export function pinned(): Record<CliId, PinnedCli> | undefined {
  if (pinnedCache) return pinnedCache;
  const file = path.join(process.cwd(), "cli.json");
  if (!existsSync(file)) return undefined;
  pinnedCache = JSON.parse(readFileSync(file, "utf8")) as Record<CliId, PinnedCli>;
  return pinnedCache;
}

/* ── the person's install ──────────────────────────────────────── */

/** Where people's installs live; an app opened from Finder does not get the shell's PATH. */
export function installCandidates(name: string, env: Record<string, string | undefined> = process.env, home = os.homedir()): string[] {
  const dirs = [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    ...(env.PATH ?? "").split(":").filter(Boolean),
  ];
  return [...new Set(dirs)].map((dir) => path.join(dir, name));
}

async function versionOf(file: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(file, ["--version"], { timeout: 15_000 });
    return parseVersion(stdout)?.join(".");
  } catch {
    return undefined;
  }
}

async function findInstalled(id: CliId, minimum: string): Promise<CliChoice | undefined> {
  // Test runs can check the download path on a Mac that has both installed.
  if (process.env.MLCH_CLI_IGNORE_INSTALLED === "1") return undefined;
  for (const candidate of installCandidates(PACKAGES[id].name)) {
    let file: string;
    try {
      if (!statSync(candidate).isFile()) continue;
      file = realpathSync(candidate);
    } catch {
      continue;
    }
    const version = await versionOf(file);
    if (!version || !atLeast(version, minimum) || state().bad.has(`${file}@${version}`)) continue;
    return { path: file, source: "installed", version };
  }
  return undefined;
}

/* ── the tested copy ───────────────────────────────────────────── */

export function cliDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "mlch", "cli");
}

async function download(id: CliId, pin: PinnedCli): Promise<CliChoice> {
  const dir = path.join(cliDir(), `${id}-${pin.version}`);
  const binary = path.join(dir, pin.binary);
  if (existsSync(path.join(dir, ".verified")) && existsSync(binary)) return { path: binary, source: "downloaded", version: pin.version };
  const status = state().status;
  status.set(id, { state: "downloading", progress: 0 });
  const response = await fetch(pin.tarball);
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
  const total = Number(response.headers.get("content-length")) || 0;
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    received += chunk.length;
    if (total) status.set(id, { state: "downloading", progress: received / total });
  }
  const bytes = Buffer.concat(chunks);
  const [algorithm, expected] = pin.integrity.split("-", 2);
  if (createHash(algorithm).update(bytes).digest("base64") !== expected) throw new Error("The download does not match the expected file.");
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const archive = path.join(dir, "package.tgz");
  await fs.writeFile(archive, bytes);
  await run("/usr/bin/tar", ["-xzf", archive, "-C", dir]);
  await fs.rm(archive);
  // The maker's signature, not just any signature.
  await run("/usr/bin/codesign", ["--verify", "--strict", binary]);
  const { stderr } = await run("/usr/bin/codesign", ["-dv", binary]);
  if (!stderr.includes(`TeamIdentifier=${pin.team}`)) throw new Error("The download is not signed by its maker.");
  await fs.writeFile(path.join(dir, ".verified"), new Date().toISOString());
  log.info("cli", "Downloaded a CLI", { id, version: pin.version });
  return { path: binary, source: "downloaded", version: pin.version };
}

/* ── choosing ──────────────────────────────────────────────────── */

/**
 * Work out the CLI to use: the person's install, else the tested copy, which
 * is downloaded only with `download` (the AI in use, or the person asked).
 * Shared by concurrent callers.
 */
export function prepareCli(id: CliId, options: { download?: boolean } = {}): Promise<CliChoice | undefined> {
  const s = state();
  const existing = s.preparing.get(id);
  if (existing && (!options.download || s.status.get(id)?.state !== "checking")) return existing;
  const pin = pinned();
  if (!pin) return Promise.resolve(undefined);
  const work = (async () => {
    if (s.status.get(id)?.state !== "downloading") s.status.set(id, { state: "checking" });
    try {
      const downloaded = path.join(cliDir(), `${id}-${pin[id].version}`, ".verified");
      let choice = await findInstalled(id, pin[id].version);
      if (!choice && (options.download || existsSync(downloaded))) choice = await download(id, pin[id]);
      if (!choice) {
        s.status.set(id, { state: "missing" });
        return undefined;
      }
      s.choices.set(id, choice);
      s.status.set(id, { state: "ready" });
      log.info("cli", "Using a CLI", { id, source: choice.source, version: choice.version });
      return choice;
    } catch (error) {
      s.status.set(id, { state: "failed", error: error instanceof Error ? error.message : String(error) });
      log.error("cli", "Getting a CLI ready failed", { id, error });
      return undefined;
    } finally {
      s.preparing.delete(id);
    }
  })();
  s.preparing.set(id, work);
  return work;
}

/** The CLI to run now, or why not yet (starts getting it ready). Undefined outside the packaged app. */
export function managedCli(id: CliId): { path: string; source: CliChoice["source"] } | { path: null; problem: string } | undefined {
  if (!pinned()) return undefined;
  const choice = state().choices.get(id);
  if (choice && existsSync(choice.path)) return { path: choice.path, source: choice.source };
  const status = state().status.get(id);
  if (!status) void prepareCli(id);
  const name = id === "claude" ? "Claude Code" : "Codex";
  if (status?.state === "missing") return { path: null, problem: `${name} isn't installed on this Mac.` };
  if (status?.state === "failed") return { path: null, problem: `${name} could not be set up: ${status.error}` };
  if (status?.state === "downloading") return { path: null, problem: `Downloading ${name}${status.progress ? ` (${Math.round(status.progress * 100)}%)` : ""}.` };
  return { path: null, problem: `Getting ${name} ready.` };
}

export function cliStatus(id: CliId): CliState | undefined {
  return state().status.get(id);
}

/**
 * A turn failed on the person's own install in a way that may be a version
 * mismatch: stop using it this run and switch to the tested copy.
 */
export function cliFailed(id: CliId): void {
  const choice = state().choices.get(id);
  if (choice?.source !== "installed") return;
  state().bad.add(`${choice.path}@${choice.version}`);
  state().choices.delete(id);
  log.warn("cli", "An installed CLI failed; switching to the tested version", { id, version: choice.version });
  void prepareCli(id, { download: true });
}
