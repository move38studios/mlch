/**
 * An image from the web for the canvas (the AI's add_image): https only, never
 * this Mac or the local network (also after a redirect), an image type, at most 15 MB. Server-only.
 */

import { lookup } from "node:dns/promises";
import net from "node:net";

const MAX_BYTES = 15 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg", "image/avif": ".avif" };

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
export async function fetchImage(url: string, hops = 2): Promise<{ bytes: Buffer; extension: string } | { error: string }> {
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
    response = await fetch(parsed, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { Accept: "image/*" } });
  } catch {
    return { error: "The image could not be downloaded." };
  }
  if (response.status >= 300 && response.status < 400) {
    const next = response.headers.get("location");
    if (!next || hops <= 0) return { error: "The image address redirects too often." };
    return fetchImage(new URL(next, parsed).toString(), hops - 1);
  }
  return readImage(response);
}

async function readImage(response: Response): Promise<{ bytes: Buffer; extension: string } | { error: string }> {
  if (!response.ok) return { error: `The site answered ${response.status}.` };
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const extension = TYPES[type];
  if (!extension) return { error: `Not an image (${type || "no type"}). Give the address of the image itself, not the page it is on.` };
  if (Number(response.headers.get("content-length")) > MAX_BYTES) return { error: "The image is over 15 MB." };
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) return { error: "The image is over 15 MB." };
  return { bytes, extension };
}
