import { handle, jsonError } from "@/lib/http";
import { readCheckpoint, restoreCheckpoint } from "@/lib/napkin/history";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; at: string }> };

/** The napkin as it was at a checkpoint. */
export async function GET(_request: Request, { params }: Params) {
  const { id, at } = await params;
  const time = Number(at);
  if (!Number.isSafeInteger(time)) return jsonError(400, "Invalid checkpoint.");
  return handle(async () => {
    try {
      return { napkin: await readCheckpoint(id, time) };
    } catch {
      return jsonError(404, "Checkpoint not found.");
    }
  });
}

/** Restore the napkin to this checkpoint. */
export async function POST(_request: Request, { params }: Params) {
  const { id, at } = await params;
  const time = Number(at);
  if (!Number.isSafeInteger(time)) return jsonError(400, "Invalid checkpoint.");
  return handle(async () => {
    await restoreCheckpoint(id, time);
    return { ok: true };
  });
}
