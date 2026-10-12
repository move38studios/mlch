import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handle, jsonError } from "@/lib/http";
import { resolveReadable } from "@/lib/agent/files";
import { readSettings, writeSettings } from "@/lib/settings";
import { isVault, sourceStatus, syncSources } from "@/lib/sources/sources";

export const dynamic = "force-dynamic";

async function view() {
  const sources = await syncSources();
  return { sources: sources.map((source) => ({ ...source, vault: isVault(source), status: sourceStatus(source.id) ?? null })) };
}

/** GET /api/sources: linked folders with their indexing state. */
export async function GET() {
  return handle(view);
}

/** Folders too broad to be useful context: linking one asks first. */
function tooBroad(folder: string): boolean {
  const home = os.homedir();
  const broad = ["/", home, ...["Documents", "Downloads", "Desktop", "Library", "Pictures", "Movies", "Music", "dev", "Developer", "code", "src", "Projects"].map((name) => path.join(home, name))];
  return broad.includes(folder) || folder === path.parse(folder).root || folder.startsWith("/Volumes/") && folder.split("/").length <= 3;
}

/** POST /api/sources {path, confirm?}: link a folder. A very broad one (home, Documents, a whole disk) needs confirm. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { path?: unknown; confirm?: unknown };
  const folder = typeof body.path === "string" ? path.resolve(body.path.replace(/^~(?=\/|$)/, os.homedir())) : "";
  if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) return jsonError(400, "That folder does not exist.");
  if (folder.startsWith(os.homedir() + path.sep) && !resolveReadable(os.homedir(), folder)) return jsonError(400, "That folder holds private data and cannot be linked.");
  if (tooBroad(folder) && body.confirm !== true) {
    return Response.json({ confirm: `${path.basename(folder) || folder} is a very broad folder. mlch would read every note and document in it, up to 20,000 files, and use them in every canvas. A folder of notes or documents you want mlch to build on works better.` }, { status: 409 });
  }
  return handle(async () => {
    const settings = await readSettings();
    if (settings.sources.some((source) => source.path === folder)) return view();
    const id = randomBytes(8).toString("hex");
    await writeSettings({ sources: [...settings.sources, { id, path: folder, name: path.basename(folder), mode: "auto" }] });
    return view();
  });
}
