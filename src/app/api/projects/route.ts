import { handle, jsonError } from "@/lib/http";
import { createProject, deleteProject, listProjects, renameProject } from "@/lib/projects/projects";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => ({ projects: await listProjects() }));
}

/** POST {name}: a new project. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  if (typeof body.name !== "string" || !body.name.trim()) return jsonError(400, "Give the project a name.");
  const name = body.name;
  return handle(async () => ({ project: await createProject(name) }));
}

/** PATCH {id, name}: rename. */
export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; name?: unknown };
  if (typeof body.id !== "string" || typeof body.name !== "string" || !body.name.trim()) return jsonError(400, "Give the project's id and a name.");
  const { id, name } = body as { id: string; name: string };
  return handle(async () => ({ project: await renameProject(id, name) }));
}

/** DELETE ?id=: the project goes; its mulches stay, in no project. */
export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return jsonError(400, "Give the project's id.");
  return handle(async () => {
    await deleteProject(id);
    return { ok: true };
  });
}
