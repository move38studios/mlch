import path from "node:path";
import { handle, jsonError } from "@/lib/http";
import { ARTIFACT_PATH } from "@/lib/artifacts/artifacts";
import { desktopRequest } from "@/lib/desktop/server";
import { napkinDir } from "@/lib/napkin/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Open an artifact or write-up in its default app (Keynote, PowerPoint, a browser…). */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { docPath?: unknown };
  const docPath = typeof body.docPath === "string" ? body.docPath : "";
  if (!ARTIFACT_PATH.test(docPath) && !/^docs\/[a-z0-9-]+\.md$/.test(docPath)) return jsonError(400, "Invalid file.");
  return handle(async () => {
    const result = await desktopRequest("open", { path: path.join(napkinDir(id), docPath) });
    if (!result.ok) return jsonError(400, result.error);
    return { ok: true };
  });
}
