import { handle, jsonError } from "@/lib/http";
import { copyCardFiles } from "@/lib/links/links";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").slice(0, 500) : []);

/**
 * POST {from, assets, docPaths}: copy the files of cards being pasted or duplicated
 * here from mulch `from` (this one or another). Returns {docPaths: {old: new}}.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { from?: unknown; assets?: unknown; docPaths?: unknown };
  if (typeof body.from !== "string") return jsonError(400, "Give from: the mulch the cards were copied from.");
  const from = body.from;
  return handle(async () => ({ docPaths: await copyCardFiles(id, from, strings(body.assets), strings(body.docPaths)) }));
}
