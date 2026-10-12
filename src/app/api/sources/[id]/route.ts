import { handle, jsonError } from "@/lib/http";
import { readSettings, writeSettings } from "@/lib/settings";
import { isVault, sourceStatus, syncSources } from "@/lib/sources/sources";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

async function view() {
  const sources = await syncSources();
  return { sources: sources.map((source) => ({ ...source, vault: isVault(source), status: sourceStatus(source.id) ?? null })) };
}

/** PATCH {mode?, name?, writeFolder? (null turns adding notes off)}. */
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { mode?: unknown; name?: unknown; writeFolder?: unknown };
  return handle(async () => {
    const settings = await readSettings();
    const source = settings.sources.find((s) => s.id === id);
    if (!source) return jsonError(404, "No such linked folder.");
    const next = { ...source };
    if (body.mode === "auto" || body.mode === "asked") next.mode = body.mode;
    if (typeof body.name === "string" && body.name.trim()) next.name = body.name.trim().slice(0, 200);
    if (body.writeFolder === null) delete next.writeFolder;
    else if (typeof body.writeFolder === "string") {
      const folder = body.writeFolder.trim().replace(/^\/+|\/+$/g, "");
      if (folder.split("/").includes("..")) return jsonError(400, "The folder must be inside the linked folder.");
      next.writeFolder = folder;
    }
    await writeSettings({ sources: settings.sources.map((s) => (s.id === id ? next : s)) });
    return view();
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  return handle(async () => {
    const settings = await readSettings();
    await writeSettings({ sources: settings.sources.filter((s) => s.id !== id) });
    return view();
  });
}
