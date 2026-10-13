import { guardAgent, handle, jsonError } from "@/lib/http";
import { ShareError } from "@/lib/share/client";
import { openShare } from "@/lib/share/shares";

export const dynamic = "force-dynamic";

/** POST {manifest}: "Open in mlch": one's own share opens its mulch; someone else's becomes a new one. */
export async function POST(request: Request) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { manifest?: unknown };
  if (typeof body.manifest !== "string") return jsonError(400, "Give the share's manifest link.");
  const manifest = body.manifest;
  return handle(async () => {
    try {
      return await openShare(manifest);
    } catch (error) {
      if (error instanceof ShareError) return jsonError(error.status === 400 ? 400 : 502, error.message);
      throw error;
    }
  });
}
