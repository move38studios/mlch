import { guardAgent, handle, jsonError } from "@/lib/http";
import { log } from "@/lib/log";
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
  const body = (await request.json().catch(() => ({}))) as { kind?: unknown; nodeId?: unknown; preview?: unknown };
  // The canvas as the person sees it, for the link preview (a PNG from the desktop shell, at most 4 MB).
  const preview = typeof body.preview === "string" && body.preview.length < 6_000_000 ? Buffer.from(body.preview, "base64") : undefined;
  return handle(async () => {
    try {
      const share = body.kind === "artifact" && typeof body.nodeId === "string" ? await shareArtifact(id, body.nodeId) : body.kind === "mulch" ? await shareMulch(id, preview) : undefined;
      if (!share) return jsonError(400, 'Give kind "mulch", or kind "artifact" with nodeId.');
      return { share, shares: (await readShares(id)).map(viewOf) };
    } catch (error) {
      // 401/402/409: what the person needs to do (sign in, subscribe, set up sharing); the page offers Settings.
      if (error instanceof ShareError) return jsonError([401, 402, 409, 429].includes(error.status) ? error.status : 502, error.message);
      // fetch's network failure (not any TypeError: a bug should show as one, in the log).
      if (error instanceof TypeError && error.message === "fetch failed") {
        log.warn("share", "server not reached", { mulchId: id, error });
        return jsonError(502, "The sharing server could not be reached.");
      }
      throw error;
    }
  });
}
