import { handle } from "@/lib/http";
import { listMulches } from "@/lib/mulch/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Other mulches stay listed this long after their work last ran or finished. */
const RECENT_MS = 30 * 60_000;

/**
 * The other mulches with the person's work in them: running, paused, waiting
 * for an answer, with results or a failure not yet seen, or active in the last
 * half hour. And whether this one is in focus mode.
 */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => {
    const all = await listMulches();
    const now = Date.now();
    const others = all
      .filter((m) => m.id !== id && !m.archivedAt && m.activity)
      .filter(({ activity: a }) => a!.working || a!.paused || a!.waiting || a!.unseen || a!.failed || now - (a!.lastAt ?? 0) < RECENT_MS)
      .map((m) => ({ id: m.id, title: m.title, activity: m.activity! }));
    return { focus: !!all.find((m) => m.id === id)?.focus, others };
  });
}
