import { guardAgent, handle, jsonError } from "@/lib/http";
import { submitCommand } from "@/lib/agent/jobs";
import { getMulch } from "@/lib/mulch/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { instruction?: unknown };
  const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 4000) : "";
  if (!instruction) return jsonError(400, "Empty instruction.");
  return handle(async () => {
    await getMulch(id);
    submitCommand(id, instruction);
    return { ok: true };
  });
}
