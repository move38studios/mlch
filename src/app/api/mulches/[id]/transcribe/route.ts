import { guardAgent, handle, jsonError } from "@/lib/http";
import { log } from "@/lib/log";
import { submitInput } from "@/lib/agent/jobs";
import { newClientId } from "@/lib/mulch/ids";
import { appendTranscript, openMulch } from "@/lib/mulch/store";
import { getTranscriber } from "@/lib/voice/transcriber";
import { micSpeaker } from "@/lib/voice/local";
import { speechWords } from "@/lib/words/speech";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MAX_BYTES = 20 * 1024 * 1024;

/** One chunk of recorded speech (WAV body). Transcribes it and feeds it to the mulch. */
export async function POST(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id } = await params;
  const recordedAt = Number(new URL(request.url).searchParams.get("at")) || Date.now();
  const audio = await request.blob();
  if (!audio.size) return jsonError(400, "Empty audio.");
  if (audio.size > MAX_BYTES) return jsonError(413, "Audio chunk too large.");
  return handle(async () => {
    const entry = await openMulch(id);
    const recent = entry.transcript.slice(-6).map((s) => s.text).join(" ");
    const started = Date.now();
    const transcriber = await getTranscriber();
    const words = await speechWords(id, recent);
    const text = words.fix(await transcriber.transcribe(new Blob([audio], { type: "audio/wav" }), { prompt: words.prompt, signal: request.signal }));
    log.info("voice", "chunk transcribed", { mulchId: id, via: transcriber.id, bytes: audio.size, ms: Date.now() - started, chars: text.length });
    if (!text) return { segment: null };
    const speaker = micSpeaker(id);
    const segment = { id: newClientId("s"), at: recordedAt, text, source: "speech" as const, ...(speaker ? { speaker } : {}) };
    await appendTranscript(id, segment);
    submitInput(id, segment);
    return { segment };
  });
}
