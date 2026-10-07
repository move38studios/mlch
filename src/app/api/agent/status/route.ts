import { guardAgent, handle } from "@/lib/http";
import { getHarness } from "@/lib/agent/server/harnesses";
import { AGENT_HARNESS_IDS } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardAgent(request);
  if (denied) return denied;
  return handle(async () => ({ harnesses: await Promise.all(AGENT_HARNESS_IDS.map((id) => getHarness(id).getStatus())) }));
}
