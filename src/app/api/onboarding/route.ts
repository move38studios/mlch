import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardAgent, handle, jsonError } from "@/lib/http";
import { getCredential, isDesktop } from "@/lib/desktop/server";
import { listMulches } from "@/lib/mulch/store";
import { embed } from "@/lib/search/embed";
import { readSettings, writeSettings } from "@/lib/settings";
import { localStatus } from "@/lib/voice/local";

export const dynamic = "force-dynamic";

const SEARCH_MODEL = path.join(os.homedir(), ".mlch", "models", "Xenova", "multilingual-e5-small", "onnx", "model_quantized.onnx");
const searchState = globalThis as typeof globalThis & { __mlchSearchModel?: "downloading" | "failed" };

/** What the first-run checklist needs: transcription, the search model, whether it was done. The AI is checked by /api/agent/status. */
export async function GET() {
  return handle(async () => {
    const settings = await readSettings();
    // A library already in use before the checklist existed counts as set up.
    const onboarded = settings.onboarded || (await listMulches()).length > 0;
    return {
      onboarded,
      desktop: isDesktop(),
      transcription: settings.transcription,
      groqKey: !!getCredential("groq"),
      local: await localStatus().catch(() => ({ installed: false, model: "unavailable" as const })),
      searchModel: existsSync(SEARCH_MODEL) ? "present" : (searchState.__mlchSearchModel ?? "missing"),
    };
  });
}

/** {action: "download-search"} fetches the search model; {action: "done"} finishes the checklist. */
export async function POST(request: Request) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  if (body.action === "download-search") {
    if (!existsSync(SEARCH_MODEL) && searchState.__mlchSearchModel !== "downloading") {
      searchState.__mlchSearchModel = "downloading";
      void embed(["warm up"], "query", 600_000).then((vectors) => {
        searchState.__mlchSearchModel = vectors ? undefined : "failed";
      });
    }
    return handle(async () => ({ ok: true }));
  }
  if (body.action === "done") return handle(async () => (await writeSettings({ onboarded: true }), { ok: true }));
  return jsonError(400, 'action is "download-search" or "done".');
}
