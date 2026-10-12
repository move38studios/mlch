import { guardAgent, handle, jsonError } from "@/lib/http";
import { ShareError } from "@/lib/share/client";
import { deleteShare, stopLive } from "@/lib/share/shares";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; shareId: string }> };

/** PATCH {live: false}: stop live updates; the link keeps the last state. */
export async function PATCH(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id, shareId } = await params;
  const body = (await request.json().catch(() => ({}))) as { live?: unknown };
  if (body.live !== false) return jsonError(400, "Only {live: false} is supported; share again to go live.");
  return handle(async () => ({ shares: await stopLive(id, shareId) }));
}

/** Delete the link and everything uploaded for it. */
export async function DELETE(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id, shareId } = await params;
  return handle(async () => {
    try {
      return { shares: await deleteShare(id, shareId) };
    } catch (error) {
      if (error instanceof ShareError) return jsonError(502, error.message);
      throw error;
    }
  });
}
