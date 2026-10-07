import { guardAgent, handle, jsonError } from "@/lib/http";
import { addPastedText } from "@/lib/ingest/place";
import { getNapkin } from "@/lib/napkin/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { text?: unknown; x?: unknown; y?: unknown };
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 2_000_000) : "";
  if (!text) return jsonError(400, "Empty text.");
  return handle(async () => {
    await getNapkin(id);
    return { node: await addPastedText(id, text, { x: Number(body.x) || 0, y: Number(body.y) || 0 }) };
  });
}
