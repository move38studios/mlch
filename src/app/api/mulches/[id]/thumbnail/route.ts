import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { jsonError } from "@/lib/http";
import { artifactFile } from "@/lib/artifacts/artifacts";
import { hasThumbnail } from "@/lib/artifacts/thumbnails";
import { desktopRequest, isDesktop } from "@/lib/desktop/server";
import { assetPath } from "@/lib/ingest/ingest";
import { log } from "@/lib/log";
import { atomicWriteFile, mulchDir } from "@/lib/mulch/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * A preview image of a deck or document (`?doc=artifacts/…` or `?asset=…`),
 * made by Quick Look in the desktop app and kept in `<mulch>/.thumbs` until
 * the file changes.
 */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const url = new URL(request.url);
  const doc = url.searchParams.get("doc");
  const asset = url.searchParams.get("asset");
  let file: string;
  try {
    file = doc ? artifactFile(id, doc) : asset ? assetPath(id, asset) : "";
  } catch {
    return jsonError(400, "Not a file of this mulch.");
  }
  if (!file || !hasThumbnail(file)) return jsonError(400, "No preview for that kind of file.");
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat?.isFile()) return jsonError(404, "Not found.");

  const key = createHash("sha1").update(`${path.relative(mulchDir(id), file)}:${stat.mtimeMs}:${stat.size}`).digest("hex").slice(0, 20);
  const cached = path.join(mulchDir(id), ".thumbs", `${key}.png`);
  const none = cached.replace(/\.png$/, ".none");
  let png = await fs.readFile(cached).catch(() => undefined);
  if (!png) {
    // Quick Look is asked once per version of the file.
    if (await fs.stat(none).catch(() => undefined)) return jsonError(404, "No preview.");
    const result = await desktopRequest("thumbnail", { path: file, size: 800 });
    if (!result.ok || typeof result.value !== "string") {
      if (!result.ok) log.info("artifacts", "no thumbnail", { mulchId: id, error: result.error });
      if (isDesktop()) await atomicWriteFile(none, "").catch(() => {});
      return jsonError(404, "No preview.");
    }
    png = Buffer.from(result.value, "base64");
    await atomicWriteFile(cached, png).catch((error) => log.warn("artifacts", "thumbnail cache failed", { mulchId: id, error }));
  }
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
