import { handle, jsonError } from "@/lib/http";
import { downloadModel, localStatus } from "@/lib/voice/local";

export const dynamic = "force-dynamic";

/** Local transcription: whether it is installed, and the model's state (with download progress). */
export async function GET() {
  return handle(localStatus);
}

/** { action: "download" } starts the model download. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  if (body.action !== "download") return jsonError(400, 'The only action is "download".');
  return handle(downloadModel);
}
