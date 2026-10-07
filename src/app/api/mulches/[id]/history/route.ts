import { handle } from "@/lib/http";
import { listCheckpoints } from "@/lib/mulch/history";
import { getMulch } from "@/lib/mulch/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => {
    await getMulch(id);
    return { checkpoints: await listCheckpoints(id) };
  });
}
