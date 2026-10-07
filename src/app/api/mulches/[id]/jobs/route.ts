import { handle, jsonError } from "@/lib/http";
import { cancelJob, retryJob } from "@/lib/agent/jobs";
import { markJobsSeen } from "@/lib/mulch/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** One job: stop it, start it again, or mark finished jobs as seen. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; jobId?: unknown; ids?: unknown };
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  return handle(async () => {
    switch (body.action) {
      case "cancel":
        if (!jobId) return jsonError(400, "Which job?");
        return { ok: cancelJob(id, jobId) };
      case "retry": {
        if (!jobId) return jsonError(400, "Which job?");
        const job = await retryJob(id, jobId);
        return job ? { job } : jsonError(400, "That job cannot be started again.");
      }
      case "seen": {
        const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string").slice(0, 100) : [];
        await markJobsSeen(id, ids);
        return { ok: true };
      }
      default:
        return jsonError(400, "Unknown action.");
    }
  });
}
