import { handle, jsonError } from "@/lib/http";
// Registers the checkpoint hook for edits.
import "@/lib/napkin/history";
// Registers the search index hook.
import "@/lib/search";
import { parseOps } from "@/lib/napkin/schema";
import { applyToNapkin } from "@/lib/napkin/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const parsed = parseOps(await request.json().catch(() => null));
  if (!parsed.ok) return jsonError(400, parsed.error);
  return handle(async () => {
    const batch = await applyToNapkin(id, parsed.ops, "user", parsed.clientId);
    return { batchId: batch?.id ?? null };
  });
}
