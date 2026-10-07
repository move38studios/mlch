import { guardAgent, handle, jsonError } from "@/lib/http";
import { isHttpUrl } from "@/lib/ingest/ingest";
import { addLink } from "@/lib/ingest/place";
import { getMulch } from "@/lib/mulch/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { url?: unknown; x?: unknown; y?: unknown };
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!isHttpUrl(url)) return jsonError(400, "Not a web link.");
  return handle(async () => {
    await getMulch(id);
    return { node: await addLink(id, url, { x: Number(body.x) || 0, y: Number(body.y) || 0 }) };
  });
}
