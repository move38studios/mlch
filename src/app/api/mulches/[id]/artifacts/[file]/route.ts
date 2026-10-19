import fs from "node:fs/promises";
import { jsonError } from "@/lib/http";
import { ARTIFACT_CSP, ARTIFACT_MIME, artifactFile } from "@/lib/artifacts/artifacts";
import { currentPlayer } from "@/lib/artifacts/deck";
import { withLinks } from "@/lib/artifacts/links";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; file: string }> };

/** An artifact, sandboxed (see lib/artifacts/artifacts.ts). */
export async function GET(_request: Request, { params }: Params) {
  const { id, file } = await params;
  const extension = file.split(".").pop() ?? "";
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(artifactFile(id, `artifacts/${file}`));
  } catch {
    return jsonError(404, "Not found.");
  }
  // A deck built before the slide bar plays with today's player; web links open in the browser.
  if (extension === "html") bytes = Buffer.from(withLinks(currentPlayer(bytes.toString("utf8"))));
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": ARTIFACT_MIME[extension] ?? "application/octet-stream",
      "Content-Security-Policy": ARTIFACT_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      ...(extension === "pptx" ? { "Content-Disposition": `attachment; filename="${file}"` } : {}),
    },
  });
}
