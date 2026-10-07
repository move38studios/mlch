/**
 * Structured logging for the Mulch server. Server-only.
 *
 *   log.info("jobs", "job finished", { mulchId, jobId, ms: 5200 })
 *
 * One JSON object per line in <logs>/mulch.jsonl (the app's logs folder, see
 * electron/main.cjs; ~/Library/Logs/mulch in browser development), rotated at
 * 5 MB with four old files kept. Secrets are redacted: stored keys, key-like
 * fields, bearer tokens. Lines also go to the console, which Electron keeps
 * in desktop.log. Logging never throws.
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  t: string;
  level: LogLevel;
  area: string;
  msg: string;
  [key: string]: unknown;
}

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 4;

export function logsDir(): string {
  return process.env.MULCH_LOGS_DIR || path.join(os.homedir(), "Library", "Logs", "Mulch");
}

export function logFile(): string {
  return path.join(logsDir(), "mulch.jsonl");
}

type Globals = typeof globalThis & {
  __mulchRedact?: (value: string) => string;
  __mulchCredentials?: Record<string, string | null | undefined>;
};

const SECRET_FIELD = /(key|token|secret|password|authorization)/i;

/** Remove anything that looks like a secret, including the keys the app holds. */
export function redact(text: string): string {
  const globals = globalThis as Globals;
  let out = globals.__mulchRedact ? globals.__mulchRedact(text) : text;
  const known = [
    ...Object.values(globals.__mulchCredentials ?? {}),
    ...["GROQ_API_KEY", "FIRECRAWL_API_KEY", "FAL_KEY", "EXA_API_KEY"].map((name) => process.env[name]),
  ].filter((value): value is string => typeof value === "string" && value.length >= 8);
  for (const secret of known) out = out.split(secret).join("[REDACTED]");
  return out.replace(/(bearer\s+|key\s+)[A-Za-z0-9._:-]{16,}/gi, "$1[REDACTED]");
}

function clean(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: redact(value.message), stack: redact(value.stack ?? "").split("\n").slice(0, 8).join("\n") };
  if (typeof value === "string") return redact(value.length > 4000 ? `${value.slice(0, 4000)}…` : value);
  if (!value || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => clean(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SECRET_FIELD.test(key) && typeof item === "string" ? "[REDACTED]" : clean(item, depth + 1)]),
  );
}

function rotate(file: string): void {
  try {
    if (statSync(file).size < MAX_BYTES) return;
  } catch {
    return;
  }
  rmSync(`${file}.${KEEP}`, { force: true });
  for (let i = KEEP - 1; i >= 1; i--) {
    try {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch {
      // missing
    }
  }
  renameSync(file, `${file}.1`);
}

let ensured = "";

function write(level: LogLevel, area: string, msg: string, data?: Record<string, unknown>): void {
  try {
    const entry: LogEntry = { t: new Date().toISOString(), level, area, msg: redact(msg), ...((clean(data ?? {}) as Record<string, unknown>) ?? {}) };
    const line = JSON.stringify(entry);
    const file = logFile();
    if (ensured !== file) {
      mkdirSync(path.dirname(file), { recursive: true });
      ensured = file;
    }
    rotate(file);
    appendFileSync(file, line + "\n");
    if (level === "error") console.error(`[${area}] ${msg}`, data ? JSON.stringify(entry).slice(0, 2000) : "");
    else if (level === "warn") console.warn(`[${area}] ${msg}`);
    else if (process.env.NODE_ENV !== "production") console.log(`[${area}] ${msg}`);
  } catch {
    // A full disk must not turn logging into a failure.
  }
}

export const log = {
  debug: (area: string, msg: string, data?: Record<string, unknown>) => {
    if (process.env.MULCH_DEBUG) write("debug", area, msg, data);
  },
  info: (area: string, msg: string, data?: Record<string, unknown>) => write("info", area, msg, data),
  warn: (area: string, msg: string, data?: Record<string, unknown>) => write("warn", area, msg, data),
  error: (area: string, msg: string, data?: Record<string, unknown>) => write("error", area, msg, data),
};
