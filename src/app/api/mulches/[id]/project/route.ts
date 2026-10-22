import { guardAgent, handle, jsonError } from "@/lib/http";
import { projectOf } from "@/lib/projects/projects";
import { dismissSuggestion, suggestProject } from "@/lib/projects/suggest";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** The project this mulch is in; with ?suggest=1 and none, the one it probably belongs to (a model call). */
export async function GET(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id } = await params;
  const suggest = new URL(request.url).searchParams.get("suggest") === "1";
  return handle(async () => {
    const project = await projectOf(id);
    return { project: project ?? null, suggestion: !project && suggest ? ((await suggestProject(id)) ?? null) : null };
  });
}

/** POST {dismiss}: don't suggest that project for this mulch again. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { dismiss?: unknown };
  if (typeof body.dismiss !== "string") return jsonError(400, "Give the project to dismiss.");
  const dismiss = body.dismiss;
  return handle(async () => {
    await dismissSuggestion(id, dismiss);
    return { ok: true };
  });
}
