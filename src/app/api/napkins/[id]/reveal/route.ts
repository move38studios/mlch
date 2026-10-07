import { handle, jsonError } from "@/lib/http";
import { desktopRequest } from "@/lib/desktop/server";
import { ARTIFACT_PATH } from "@/lib/artifacts/artifacts";
import { ASSET_ID, assetPath } from "@/lib/ingest/ingest";
import { napkinDir } from "@/lib/napkin/store";
import path from "node:path";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Show an asset or write-up (or the napkin folder) in Finder. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { assetId?: unknown; docPath?: unknown };
  let target: string;
  if (typeof body.assetId === "string") {
    if (!ASSET_ID.test(body.assetId)) return jsonError(400, "Invalid asset.");
    target = assetPath(id, body.assetId);
  } else if (typeof body.docPath === "string" && (/^docs\/[a-z0-9-]+\.md$/.test(body.docPath) || ARTIFACT_PATH.test(body.docPath))) {
    target = path.join(napkinDir(id), body.docPath);
  } else target = path.join(napkinDir(id), "napkin.json");
  return handle(async () => {
    const result = await desktopRequest("reveal", { path: target });
    if (!result.ok) return jsonError(400, result.error);
    return { ok: true };
  });
}
