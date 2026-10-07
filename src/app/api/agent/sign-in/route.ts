import { guardAgent, handle, jsonError } from "@/lib/http";
import { getHarness } from "@/lib/agent/server/harnesses";
import { AGENT_HARNESS_IDS, type AgentHarnessId } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

/** Starts the vendor's own sign-in (the CLI opens the browser). The app never sees tokens. */
export async function POST(request: Request) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { harness?: AgentHarnessId; cancel?: boolean };
  if (!body.harness || !AGENT_HARNESS_IDS.includes(body.harness)) return jsonError(400, "Unknown harness.");
  const harness = getHarness(body.harness);
  return handle(async () => {
    if (body.cancel) {
      await harness.cancelSignIn();
      return { state: "idle" };
    }
    return harness.startSignIn();
  });
}
