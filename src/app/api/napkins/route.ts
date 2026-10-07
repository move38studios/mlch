import { handle } from "@/lib/http";
import { createNapkin, listNapkins } from "@/lib/napkin/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => ({ napkins: await listNapkins() }));
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = (await request.json().catch(() => ({}))) as { title?: unknown };
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : undefined;
    return { napkin: await createNapkin(title) };
  });
}
