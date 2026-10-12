import { handle, jsonError } from "@/lib/http";
import { bringHere } from "@/lib/links/links";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** POST {nodeId}: turn a link card into a real item on this canvas, keeping its connections. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { nodeId?: unknown };
  if (typeof body.nodeId !== "string") return jsonError(400, "Give nodeId.");
  const nodeId = body.nodeId;
  return handle(async () => {
    const newId = await bringHere(id, nodeId);
    return newId ? { id: newId } : jsonError(404, "That link points at nothing that can be brought here.");
  });
}
