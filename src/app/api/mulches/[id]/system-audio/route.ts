import { guardAgent, handle, jsonError } from "@/lib/http";
import { startSystemAudio, stopSystemAudio, systemAudioFor } from "@/lib/voice/local";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** The capture of the Mac's sound output running for this mulch, if any (with its level, for an indicator). */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => ({ capture: systemAudioFor(id) ?? null }));
}

/**
 * { action: "start", target?: "all" | bundle id | process id } or { action: "stop" }.
 * What it hears is transcribed into the mulch as speech from "them" (and starts agent turns).
 */
export async function POST(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; target?: unknown };
  if (body.action === "stop") return handle(async () => ({ stopped: await stopSystemAudio(id) }));
  if (body.action !== "start") return jsonError(400, 'action is "start" or "stop".');
  const target = body.target ?? "all";
  if (!(typeof target === "string" || (Number.isInteger(target) && (target as number) > 0))) {
    return jsonError(400, 'target is "all", an app\'s bundle id (us.zoom.xos) or a process id.');
  }
  return handle(async () => ({ capture: await startSystemAudio(id, target as string | number) }));
}
