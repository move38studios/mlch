import { handle } from "@/lib/http";
import { getMulch, trashMulch } from "@/lib/mulch/store";
import { dropMulch } from "@/lib/search";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => ({ mulch: await getMulch(id) }));
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => {
    await trashMulch(id);
    dropMulch(id);
    return { ok: true };
  });
}
