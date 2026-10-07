import { guardAgent, handle, jsonError } from "@/lib/http";
import { log } from "@/lib/log";
import { submitInput } from "@/lib/agent/jobs";
import { newClientId } from "@/lib/napkin/ids";
import { appendTranscript, openNapkin } from "@/lib/napkin/store";
import { getTranscriber } from "@/lib/voice/transcriber";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MAX_BYTES = 20 * 1024 * 1024;

/** One chunk of recorded speech (WAV body). Transcribes it and feeds it to the napkin. */
export async function POST(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id } = await params;
  const recordedAt = Number(new URL(request.url).searchParams.get("at")) || Date.now();
  const audio = await request.blob();
  if (!audio.size) return jsonError(400, "Empty audio.");
  if (audio.size > MAX_BYTES) return jsonError(413, "Audio chunk too large.");
  return handle(async () => {
    const entry = await openNapkin(id);
    const recent = entry.transcript.slice(-6).map((s) => s.text).join(" ");
    const started = Date.now();
    const text = await getTranscriber().transcribe(new Blob([audio], { type: "audio/wav" }), { prompt: recent, signal: request.signal });
    log.info("voice", "chunk transcribed", { napkinId: id, bytes: audio.size, ms: Date.now() - started, chars: text.length });
    if (!text) return { segment: null };
    const segment = { id: newClientId("s"), at: recordedAt, text, source: "speech" as const };
    await appendTranscript(id, segment);
    submitInput(id, segment);
    return { segment };
  });
}
