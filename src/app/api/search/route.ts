import { handle, jsonError } from "@/lib/http";
import { listMulches } from "@/lib/mulch/store";
import { search } from "@/lib/search";
import { syncSources } from "@/lib/sources/sources";

export const dynamic = "force-dynamic";

/** GET /api/search?q=…[&mulch=<id>] — one mulch, or all of them and the linked folders. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim() ?? "";
  if (!query) return jsonError(400, "Empty query.");
  const mulch = params.get("mulch") ?? undefined;
  return handle(async () => {
    const sources = mulch ? [] : await syncSources();
    const hits = await search(query, { ...(mulch ? { mulchIds: [mulch] } : { sources: sources.map((s) => s.id) }), limit: 20 });
    const titles = new Map([...(await listMulches()).map((n) => [n.id, n.title] as const), ...sources.map((s) => [s.id, s.name] as const)]);
    return { hits: hits.map((hit) => ({ ...hit, mulchTitle: titles.get(hit.sourceId ?? hit.mulchId) ?? "" })) };
  });
}
