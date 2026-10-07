import { handle, jsonError } from "@/lib/http";
import { listNapkins } from "@/lib/napkin/store";
import { search } from "@/lib/search";

export const dynamic = "force-dynamic";

/** GET /api/search?q=…[&napkin=<id>] — one napkin, or all of them. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim() ?? "";
  if (!query) return jsonError(400, "Empty query.");
  const napkin = params.get("napkin") ?? undefined;
  return handle(async () => {
    const hits = await search(query, { ...(napkin ? { napkinIds: [napkin] } : {}), limit: 20 });
    const titles = new Map((await listNapkins()).map((n) => [n.id, n.title]));
    return { hits: hits.map((hit) => ({ ...hit, napkinTitle: titles.get(hit.napkinId) ?? "" })) };
  });
}
