import fs from "node:fs/promises";
import { jsonError } from "@/lib/http";
import { ASSET_ID, assetPath, mimeFor } from "@/lib/ingest/ingest";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; asset: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id, asset } = await params;
  if (!ASSET_ID.test(asset)) return jsonError(404, "Not found.");
  try {
    const bytes = await fs.readFile(assetPath(id, asset));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": mimeFor(asset), "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
        // An SVG opened directly must not run script.
        "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      },
    });
  } catch {
    return jsonError(404, "Not found.");
  }
}
