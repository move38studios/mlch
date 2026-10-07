import { handle, jsonError } from "@/lib/http";
// Registers the checkpoint hook for edits.
import "@/lib/mulch/history";
// Registers the search index hook.
import "@/lib/search";
// Registers the naming of untitled mulches.
import "@/lib/agent/jobs";
import { parseOps } from "@/lib/mulch/schema";
import { applyToMulch } from "@/lib/mulch/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const parsed = parseOps(await request.json().catch(() => null));
  if (!parsed.ok) return jsonError(400, parsed.error);
  return handle(async () => {
    const batch = await applyToMulch(id, parsed.ops, "user", parsed.clientId);
    return { batchId: batch?.id ?? null };
  });
}
