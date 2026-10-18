import { handle } from "@/lib/http";
import { archiveMulch, getMulch, setFocusMode, trashMulch } from "@/lib/mulch/store";
import { deleteShare, readShares } from "@/lib/share/shares";
import { log } from "@/lib/log";
import { dropMulch } from "@/lib/search";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => ({ mulch: await getMulch(id) }));
}

/** Turns off every share link of a mulch (best effort: an unreachable server leaves that link). */
async function deleteShares(id: string): Promise<void> {
  for (const record of await readShares(id)) {
    await deleteShare(id, record.id).catch((error) => log.warn("share", "share link could not be deleted", { mulchId: id, shareId: record.id, error }));
  }
}

/** PATCH {archived, stopShares?}: archive or restore; archiving can turn off its share links. PATCH {focus}: focus mode on or off. */
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { archived?: unknown; stopShares?: unknown; focus?: unknown };
  return handle(async () => {
    if (typeof body.focus === "boolean") {
      await setFocusMode(id, body.focus);
      return { ok: true };
    }
    if (body.archived === true && body.stopShares === true) await deleteShares(id);
    await archiveMulch(id, body.archived === true);
    return { ok: true };
  });
}

/** Deleting a mulch turns off its share links first: after this nothing in the app could. */
export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => {
    await deleteShares(id);
    await trashMulch(id);
    dropMulch(id);
    return { ok: true };
  });
}
