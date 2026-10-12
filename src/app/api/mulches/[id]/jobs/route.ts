import { handle, jsonError } from "@/lib/http";
import { cancelJob, retryJob } from "@/lib/agent/jobs";
import { dismissJobMessage, getJobs, getMulch, markJobsSeen, applyToMulch } from "@/lib/mulch/store";
import { newClientId } from "@/lib/mulch/ids";
import { placeNear } from "@/lib/mulch/place";
import { NODE_WIDTH } from "@/lib/mulch/sizes";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** One job: stop it, start it again, mark finished jobs as seen, or close its message. */
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
      case "keep-message": {
        // The person keeps the AI's message: a write-up card by what that job made, and the bubble closes.
        const job = (await getJobs(id)).find((j) => j.id === jobId);
        if (!job?.message) return jsonError(400, "That job has no message.");
        const mulch = await getMulch(id);
        const nodeId = newClientId("n");
        const at = placeNear(mulch, { w: NODE_WIDTH.writeup, h: 220 }, { anchorIds: job.resultIds, seed: nodeId });
        await applyToMulch(id, [{ op: "addNode", node: { id: nodeId, kind: "writeup", x: at.x, y: at.y, title: job.label, text: job.message.text, origin: `agent:${job.id}`, userTouched: true, createdAt: Date.now() } }], "user");
        await dismissJobMessage(id, jobId);
        return { nodeId };
      }
      case "dismiss-message":
        if (!jobId) return jsonError(400, "Which job?");
        await dismissJobMessage(id, jobId);
        return { ok: true };
      default:
        return jsonError(400, "Unknown action.");
    }
  });
}
