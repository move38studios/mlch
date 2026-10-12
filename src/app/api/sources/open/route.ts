import { handle, jsonError } from "@/lib/http";
import { desktopRequest } from "@/lib/desktop/server";
import { getSource, openUrl, sourceFile } from "@/lib/sources/sources";

export const dynamic = "force-dynamic";

/** POST {sourceId, path, action: "open" | "reveal"}: a linked folder's file in Obsidian (vault notes) or its default app. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { sourceId?: unknown; path?: unknown; action?: unknown };
  if (typeof body.sourceId !== "string" || typeof body.path !== "string") return jsonError(400, "Give sourceId and path.");
  const sourceId = body.sourceId;
  const relative = body.path;
  return handle(async () => {
    const source = await getSource(sourceId);
    const file = source && sourceFile(source, relative);
    if (!source || !file) return jsonError(404, "No such file in the linked folders.");
    const url = body.action === "reveal" ? undefined : openUrl(source, relative);
    const result = url ? await desktopRequest("open-url", { url }) : await desktopRequest(body.action === "reveal" ? "reveal" : "open", { path: file });
    if (!result.ok) return jsonError(400, result.error);
    return { ok: true };
  });
}
