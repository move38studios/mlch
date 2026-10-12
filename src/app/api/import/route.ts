import { guardAgent, handle, jsonError } from "@/lib/http";
import { ShareError } from "@/lib/share/client";
import { importShare } from "@/lib/share/shares";

export const dynamic = "force-dynamic";

/** POST {manifest}: "Open in mlch" — a shared canvas or file becomes a new mulch. */
export async function POST(request: Request) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { manifest?: unknown };
  if (typeof body.manifest !== "string") return jsonError(400, "Give the share's manifest link.");
  const manifest = body.manifest;
  return handle(async () => {
    try {
      return { mulchId: await importShare(manifest) };
    } catch (error) {
      if (error instanceof ShareError) return jsonError(error.status === 400 ? 400 : 502, error.message);
      throw error;
    }
  });
}
