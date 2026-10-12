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

/** POST /api/sources {path}: link a folder. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { path?: unknown };
  const folder = typeof body.path === "string" ? path.resolve(body.path.replace(/^~(?=\/|$)/, os.homedir())) : "";
  if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) return jsonError(400, "That folder does not exist.");
  if (folder.startsWith(os.homedir() + path.sep) && !resolveReadable(os.homedir(), folder)) return jsonError(400, "That folder holds private data and cannot be linked.");
  return handle(async () => {
    const settings = await readSettings();
    if (settings.sources.some((source) => source.path === folder)) return view();
    const id = randomBytes(8).toString("hex");
    await writeSettings({ sources: [...settings.sources, { id, path: folder, name: path.basename(folder), mode: "auto" }] });
    return view();
  });
}
