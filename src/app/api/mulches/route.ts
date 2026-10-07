import { handle } from "@/lib/http";
import { createMulch, listMulches } from "@/lib/mulch/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => ({ mulches: await listMulches() }));
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = (await request.json().catch(() => ({}))) as { title?: unknown };
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : undefined;
    return { mulch: await createMulch(title) };
  });
}
