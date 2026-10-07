import { handle } from "@/lib/http";
import { cancelGeneration } from "@/lib/media/generations";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; gen: string }> };

export async function POST(_request: Request, { params }: Params) {
  const { id, gen } = await params;
  return handle(async () => {
    await cancelGeneration(id, gen);
    return { ok: true };
  });
}
