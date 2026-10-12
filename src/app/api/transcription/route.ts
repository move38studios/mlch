import { guardAgent, handle, jsonError } from "@/lib/http";
import { downloadModel, localStatus } from "@/lib/voice/local";
import { getTranscriber } from "@/lib/voice/transcriber";

export const dynamic = "force-dynamic";

/** Local transcription: whether it is installed, and the model's state (with download progress). */
export async function GET() {
  return handle(localStatus);
}

/**
 * { action: "download" } starts the model download. A WAV body is a test
 * recording (onboarding): its text comes back, nothing is kept.
 */
export async function POST(request: Request) {
  if (request.headers.get("content-type") === "audio/wav") {
    const denied = guardAgent(request);
    if (denied) return denied;
    const audio = await request.blob();
    if (!audio.size || audio.size > 5 * 1024 * 1024) return jsonError(400, "A test recording is a WAV of up to 5 MB.");
    return handle(async () => ({ text: await (await getTranscriber()).transcribe(new Blob([audio], { type: "audio/wav" }), { signal: request.signal }) }));
  }
  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  if (body.action !== "download") return jsonError(400, 'The only action is "download".');
  return handle(downloadModel);
}
