import { guardAgent, handle, jsonError } from "@/lib/http";
import { addFile } from "@/lib/ingest/place";
import { getMulch } from "@/lib/mulch/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MAX_BYTES = 100 * 1024 * 1024;

/** A dropped file (raw body). ?name=&x=&y= */
export async function POST(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const name = query.get("name")?.trim();
  if (!name) return jsonError(400, "Missing file name.");
  const bytes = Buffer.from(await request.arrayBuffer());
  if (!bytes.length) return jsonError(400, "Empty file.");
  if (bytes.length > MAX_BYTES) return jsonError(413, "Files up to 100 MB.");
  return handle(async () => {
    await getMulch(id);
    return { node: await addFile(id, bytes, name, { x: Number(query.get("x")) || 0, y: Number(query.get("y")) || 0 }) };
  });
}
