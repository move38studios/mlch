import { handle } from "@/lib/http";
import { cancelJobs } from "@/lib/agent/jobs";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Stop all running and queued agent work on this mulch. */
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => {
    cancelJobs(id);
    return { ok: true };
  });
}
