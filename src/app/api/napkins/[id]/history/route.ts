import { handle } from "@/lib/http";
import { listCheckpoints } from "@/lib/napkin/history";
import { getNapkin } from "@/lib/napkin/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => {
    await getNapkin(id);
    return { checkpoints: await listCheckpoints(id) };
  });
}
