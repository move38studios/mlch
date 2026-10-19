import { guardAgent, handle } from "@/lib/http";
import { getHarness } from "@/lib/agent/server/harnesses";
import { cliStatus, prepareCli } from "@/lib/agent/server/cli";
import { AGENT_HARNESS_IDS } from "@/lib/agent/types";
import { log } from "@/lib/log";
import { readSettings } from "@/lib/settings";

/** The last problem each AI's status showed, so a new one is logged once. */
const lastProblem = new Map<string, string | undefined>();

export const dynamic = "force-dynamic";

/** Each AI's state, with its CLI's setup in the packaged app (`cli`: missing, downloading with progress, …). */
export async function GET(request: Request) {
  const denied = guardAgent(request);
  if (denied) return denied;
  return handle(async () => {
    // The AI in use is fetched if this Mac has no usable install; the other only when asked (POST).
    void prepareCli((await readSettings()).harness, { download: true });
    const harnesses = await Promise.all(AGENT_HARNESS_IDS.map((id) => getHarness(id).getStatus()));
    for (const status of harnesses) {
      if (lastProblem.get(status.id) !== status.problem) log.info("agent", status.problem ? "Status shows a problem" : "Status fine", { harness: status.id, problem: status.problem });
      lastProblem.set(status.id, status.problem);
    }
    return { harnesses: harnesses.map((status) => ({ ...status, ...(cliStatus(status.id) ? { cli: cliStatus(status.id) } : {}) })) };
  });
}

/** POST {id}: download the tested version of that AI's CLI (no usable install on this Mac). */
export async function POST(request: Request) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { id?: unknown };
  const id = AGENT_HARNESS_IDS.find((h) => h === body.id);
  if (!id) return handle(async () => ({ ok: false }));
  void prepareCli(id, { download: true });
  return handle(async () => ({ ok: true }));
}
