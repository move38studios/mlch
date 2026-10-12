import { guardAgent, handle, jsonError } from "@/lib/http";
import { ShareError } from "@/lib/share/client";
import { readShares, shareArtifact, shareMulch, viewOf } from "@/lib/share/shares";
import { getMulch } from "@/lib/mulch/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => {
    await getMulch(id);
    return { shares: (await readShares(id)).map(viewOf) };
  });
}

/** POST {kind: "mulch"} shares the canvas, live; {kind: "artifact", nodeId} one made file. Only this machine's own page. */
export async function POST(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { kind?: unknown; nodeId?: unknown };
  return handle(async () => {
    try {
      const share = body.kind === "artifact" && typeof body.nodeId === "string" ? await shareArtifact(id, body.nodeId) : body.kind === "mulch" ? await shareMulch(id) : undefined;
      if (!share) return jsonError(400, 'Give kind "mulch", or kind "artifact" with nodeId.');
      return { share, shares: (await readShares(id)).map(viewOf) };
    } catch (error) {
      if (error instanceof ShareError) return jsonError(error.status === 429 ? 429 : 502, error.message);
      if (error instanceof TypeError) return jsonError(502, "mlch.app could not be reached.");
      throw error;
    }
  });
}
