/**
 * A file from the web for the canvas (the AI's add_file, links that point at a
 * file): https only, never this Mac or the local network (also after a
 * redirect), a type the canvas can show, within its size limit. Server-only.
 */

import { lookup } from "node:dns/promises";
import net from "node:net";

const MB = 1024 * 1024;
export type FileKind = "image" | "document" | "audio" | "video";
const TYPES: Record<string, { extension: string; kind: FileKind }> = {
  "image/png": { extension: ".png", kind: "image" },
  "image/jpeg": { extension: ".jpg", kind: "image" },
  "image/gif": { extension: ".gif", kind: "image" },
  "image/webp": { extension: ".webp", kind: "image" },
  "image/svg+xml": { extension: ".svg", kind: "image" },
  "application/pdf": { extension: ".pdf", kind: "document" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { extension: ".docx", kind: "document" },
  "audio/mpeg": { extension: ".mp3", kind: "audio" },
  "audio/mp4": { extension: ".m4a", kind: "audio" },
  "audio/x-m4a": { extension: ".m4a", kind: "audio" },
  "audio/wav": { extension: ".wav", kind: "audio" },
  "audio/x-wav": { extension: ".wav", kind: "audio" },
  "audio/ogg": { extension: ".ogg", kind: "audio" },
  "audio/flac": { extension: ".flac", kind: "audio" },
  "audio/aac": { extension: ".aac", kind: "audio" },
  "video/mp4": { extension: ".mp4", kind: "video" },
  "video/webm": { extension: ".webm", kind: "video" },
  "video/quicktime": { extension: ".mov", kind: "video" },
};
export const LIMITS: Record<FileKind, number> = { image: 15 * MB, document: 30 * MB, audio: 100 * MB, video: 100 * MB };

/** Address paths that point straight at a file the canvas can hold. */
export const FILE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|pdf|docx|mp3|m4a|wav|ogg|flac|aac|mp4|webm|mov)$/i;

/** Loopback, private, link-local and similar addresses: not reachable through the AI. */
export function privateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return privateAddress(lower.slice(7));
  return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb");
}

/** Follows at most `hops` redirects, each one checked like the first address. */
export async function fetchFile(url: string, hops = 2): Promise<{ bytes: Buffer; extension: string; kind: FileKind } | { error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "Not a valid address." };
  }
  if (parsed.protocol !== "https:") return { error: "Only https addresses." };
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
  if (!addresses.length) return { error: "That host could not be found." };
  if (addresses.some(privateAddress)) return { error: "That address is on this Mac or a local network." };
  let response: Response;
  try {
    // No redirects followed blindly: a redirect could lead to a local address.
    // Some sites (Wikimedia) refuse requests that do not say who they are.
    response = await fetch(parsed, { redirect: "manual", signal: AbortSignal.timeout(120_000), headers: { "User-Agent": "mlch/0.1 (+https://mlch.app)" } });
  } catch {
    return { error: "The image could not be downloaded." };
  }
  if (response.status >= 300 && response.status < 400) {
    const next = response.headers.get("location");
    if (!next || hops <= 0) return { error: "The image address redirects too often." };
    return fetchFile(new URL(next, parsed).toString(), hops - 1);
  }
  return readFile(response);
}

async function readFile(response: Response): Promise<{ bytes: Buffer; extension: string; kind: FileKind } | { error: string }> {
  if (!response.ok) return { error: `The site answered ${response.status}.` };
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const known = TYPES[type];
  if (!known) return { error: `Not a file the canvas can hold (${type || "no type"}): pictures, PDF, Word, audio and video. For a page, add a link instead.` };
  const limit = LIMITS[known.kind];
  const tooBig = { error: `The file is over ${Math.round(limit / MB)} MB.` };
  if (Number(response.headers.get("content-length")) > limit) return tooBig;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) return tooBig;
  return { bytes, extension: known.extension, kind: known.kind };
}

/** A picture only (for callers that need one). */
export async function fetchImage(url: string): Promise<{ bytes: Buffer; extension: string } | { error: string }> {
  const got = await fetchFile(url);
  if ("error" in got) return got;
  return got.kind === "image" ? got : { error: "Not a picture." };
}
