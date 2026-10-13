import { handle, jsonError } from "@/lib/http";
import { listMulches, peekMulch } from "@/lib/mulch/store";
import { search } from "@/lib/search";
import { syncSources } from "@/lib/sources/sources";

export const dynamic = "force-dynamic";

const DAY = 24 * 60 * 60 * 1000;

/**
 * GET /api/search?q=…[&mulch=<id>][&limit=n] — one mulch, or all of them and
 * the linked folders. Each hit carries its item's date; recent items get a small lift.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim() ?? "";
  if (!query) return jsonError(400, "Empty query.");
  const mulch = params.get("mulch") ?? undefined;
  const limit = Math.min(60, Math.max(1, Number(params.get("limit")) || 20));
  return handle(async () => {
    const sources = mulch ? [] : await syncSources();
    const hits = await search(query, { ...(mulch ? { mulchIds: [mulch] } : { sources: sources.map((s) => s.id) }), limit });
    const titles = new Map([...(await listMulches()).map((n) => [n.id, n.title] as const), ...sources.map((s) => [s.id, s.name] as const)]);
    const mulches = new Map(await Promise.all([...new Set(hits.filter((h) => h.mulchId).map((h) => h.mulchId))].map(async (id) => [id, await peekMulch(id).catch(() => undefined)] as const)));
    const now = Date.now();
    const dated = hits.map((hit) => {
      const node = hit.mulchId ? mulches.get(hit.mulchId)?.nodes[hit.nodeId] : undefined;
      const at = node ? node.updatedAt ?? node.createdAt : undefined;
      const lift = at ? 1 + 0.2 * Math.exp(-(now - at) / (30 * DAY)) : 1;
      return { ...hit, mulchTitle: titles.get(hit.sourceId ?? hit.mulchId) ?? "", ...(at ? { at } : {}), score: hit.score * lift };
    });
    return { hits: dated.sort((a, b) => b.score - a.score) };
  });
}
