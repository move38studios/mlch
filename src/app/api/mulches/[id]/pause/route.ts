import { handle } from "@/lib/http";
import { setEnrichmentPaused } from "@/lib/agent/jobs";
import { setPaused } from "@/lib/mulch/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Pause or resume enrichment for this mulch. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { paused?: unknown };
  const paused = body.paused === true;
  return handle(async () => {
    await setPaused(id, paused);
    setEnrichmentPaused(id, paused);
    return { paused };
  });
}
