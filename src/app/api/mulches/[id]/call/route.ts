import { guardAgent, handle, jsonError } from "@/lib/http";
import { inCall, setCallMode } from "@/lib/agent/jobs";
import { log } from "@/lib/log";
import { getMulch } from "@/lib/mulch/store";
import { startSystemAudio, stopSystemAudio, systemAudioFor } from "@/lib/voice/local";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Whether a call is being listened to here, and the Mac's sound capture with its level. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => ({ call: inCall(id), capture: systemAudioFor(id) ?? null }));
}

/**
 * {action: "start", target?: "all" | bundle id | pid}: listen to a call — the
 * Mac's sound output as "them" (the page records the microphone as "me") —
 * and capture it as conversation. If the Mac's sound cannot be captured, the
 * call still runs on the microphone and `audioError` says why.
 * {action: "stop"}: stop and capture what is left.
 */
export async function POST(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; target?: unknown };
  return handle(async () => {
    await getMulch(id);
    if (body.action === "stop") {
      await stopSystemAudio(id).catch((error) => log.warn("voice", "stopping system audio failed", { mulchId: id, error }));
      setCallMode(id, false);
      return { call: false };
    }
    if (body.action !== "start") return jsonError(400, 'action is "start" or "stop".');
    const target = typeof body.target === "string" || (Number.isInteger(body.target) && (body.target as number) > 0) ? (body.target as string | number) : "all";
    setCallMode(id, true);
    try {
      return { call: true, capture: await startSystemAudio(id, target) };
    } catch (error) {
      log.warn("voice", "system audio unavailable for a call", { mulchId: id, error });
      return { call: true, capture: null, audioError: error instanceof Error ? error.message : String(error) };
    }
  });
}
