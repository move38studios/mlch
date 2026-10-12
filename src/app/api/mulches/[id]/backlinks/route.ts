import { handle } from "@/lib/http";
import { backlinks } from "@/lib/links/links";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Link cards in other mulches that point into this one. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => ({ backlinks: await backlinks(id) }));
}
