import { handle } from "@/lib/http";
import { getNapkin, trashNapkin } from "@/lib/napkin/store";
import { dropNapkin } from "@/lib/search";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => ({ napkin: await getNapkin(id) }));
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => {
    await trashNapkin(id);
    dropNapkin(id);
    return { ok: true };
  });
}
