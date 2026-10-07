import { guardAgent, handle, jsonError } from "@/lib/http";
import { submitInput } from "@/lib/agent/jobs";
import { newClientId } from "@/lib/napkin/ids";
import { appendTranscript, getNapkin } from "@/lib/napkin/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Typed text from the input box. Speech arrives through /transcribe. */
export async function POST(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 20_000) : "";
  if (!text) return jsonError(400, "Empty input.");
  return handle(async () => {
    await getNapkin(id);
    const segment = { id: newClientId("s"), at: Date.now(), text, source: "typed" as const };
    await appendTranscript(id, segment);
    submitInput(id, segment);
    return { segment };
  });
}
