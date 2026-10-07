import fs from "node:fs/promises";
import { jsonError } from "@/lib/http";
import { ASSET_ID, assetPath, mimeFor } from "@/lib/ingest/ingest";
import { guessMime } from "@/lib/media/generations";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; asset: string }> };

/** A napkin file. Supports byte ranges so video and audio can seek. */
export async function GET(request: Request, { params }: Params) {
  const { id, asset } = await params;
  if (!ASSET_ID.test(asset)) return jsonError(404, "Not found.");
  let file: string;
  let size: number;
  try {
    file = assetPath(id, asset);
    size = (await fs.stat(file)).size;
  } catch {
    return jsonError(404, "Not found.");
  }
  const type = mimeFor(asset) !== "application/octet-stream" ? mimeFor(asset) : guessMime(asset);
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    // An SVG opened directly must not run script.
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
  };
  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const handle = await fs.open(file);
    try {
      const buffer = Buffer.alloc(end - start + 1);
      await handle.read(buffer, 0, buffer.length, start);
      return new Response(new Uint8Array(buffer), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(buffer.length) } });
    } finally {
      await handle.close();
    }
  }
  return new Response(new Uint8Array(await fs.readFile(file)), { headers: { ...headers, "Content-Length": String(size) } });
}
