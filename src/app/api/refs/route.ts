import { handle, jsonError } from "@/lib/http";
import { resolveRef } from "@/lib/links/links";

export const dynamic = "force-dynamic";

/** GET /api/refs?mulch=<id>&item=<id> or ?source=<id>&path=<path> [&full=1]: what a link card shows, read live. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const mulch = params.get("mulch");
  const item = params.get("item");
  const source = params.get("source");
  const file = params.get("path");
  const full = params.get("full") === "1";
  if (mulch && item) return handle(() => resolveRef({ mulchId: mulch, itemId: item }, full));
  if (source && file) return handle(() => resolveRef({ sourceId: source, path: file }, full));
  return jsonError(400, "Give mulch and item, or source and path.");
}
