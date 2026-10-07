import fs from "node:fs/promises";
import path from "node:path";
import { guardAgent, handle, jsonError } from "@/lib/http";
import { submitFolder } from "@/lib/agent/jobs";
import { getMulch } from "@/lib/mulch/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Explore a folder (absolute path, from the native picker) and build items from it. */
export async function POST(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { path?: unknown };
  const folder = typeof body.path === "string" ? body.path : "";
  if (!folder || !path.isAbsolute(folder)) return jsonError(400, "Choose a folder.");
  return handle(async () => {
    await getMulch(id);
    const real = await fs.realpath(folder);
    if (!(await fs.stat(real)).isDirectory()) return jsonError(400, "Not a folder.");
    submitFolder(id, real);
    return { ok: true };
  });
}
