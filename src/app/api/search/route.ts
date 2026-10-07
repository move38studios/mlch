import { handle, jsonError } from "@/lib/http";
import { listMulches } from "@/lib/mulch/store";
import { search } from "@/lib/search";

export const dynamic = "force-dynamic";

/** GET /api/search?q=…[&mulch=<id>] — one mulch, or all of them. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim() ?? "";
  if (!query) return jsonError(400, "Empty query.");
  const mulch = params.get("mulch") ?? undefined;
  return handle(async () => {
    const hits = await search(query, { ...(mulch ? { mulchIds: [mulch] } : {}), limit: 20 });
    const titles = new Map((await listMulches()).map((n) => [n.id, n.title]));
    return { hits: hits.map((hit) => ({ ...hit, mulchTitle: titles.get(hit.mulchId) ?? "" })) };
  });
}
