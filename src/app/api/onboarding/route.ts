import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardAgent, handle, jsonError } from "@/lib/http";
import { getCredential, isDesktop } from "@/lib/desktop/server";
import { log } from "@/lib/log";
import { listMulches } from "@/lib/mulch/store";
import { createStartHere } from "@/lib/onboarding/startHere";
import { embed } from "@/lib/search/embed";
import { readSettings, writeSettings } from "@/lib/settings";
import { downloadModel, localStatus } from "@/lib/voice/local";

export const dynamic = "force-dynamic";

const SEARCH_MODEL = path.join(os.homedir(), ".mlch", "models", "Xenova", "multilingual-e5-small", "onnx", "model_quantized.onnx");
const searchState = globalThis as typeof globalThis & { __mlchSearchModel?: "downloading" | "failed" };

/** Obsidian vaults on this Mac (from Obsidian's own list), to offer linking them in one click. */
function obsidianVaults(): Array<{ path: string; name: string }> {
  try {
    const file = path.join(os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
    const vaults = (JSON.parse(readFileSync(file, "utf8")) as { vaults?: Record<string, { path?: string }> }).vaults ?? {};
    return Object.values(vaults)
      .map((vault) => vault.path)
      .filter((p): p is string => !!p && existsSync(p))
      .map((p) => ({ path: p, name: path.basename(p) }));
  } catch {
    return [];
  }
}

function startSearchDownload(): void {
  if (existsSync(SEARCH_MODEL) || searchState.__mlchSearchModel === "downloading") return;
  searchState.__mlchSearchModel = "downloading";
  void embed(["warm up"], "query", 600_000).then((vectors) => {
    searchState.__mlchSearchModel = vectors ? undefined : "failed";
  });
}

/**
 * What the first-run screen needs. The first call in a library also makes
 * the "Start here" mulch; a library already in use counts as set up.
 */
export async function GET() {
  return handle(async () => {
    let settings = await readSettings();
    const patch: Record<string, boolean> = {};
    if (!settings.startHere) {
      if (!settings.onboarded && (await listMulches()).length > 0) patch.onboarded = true;
      await createStartHere().catch((error) => log.warn("onboarding", "Start here could not be made", { error }));
      patch.startHere = true;
    }
    if (Object.keys(patch).length) settings = await writeSettings(patch);
    const linked = new Set(settings.sources.map((s) => s.path));
    return {
      onboarded: settings.onboarded,
      desktop: isDesktop(),
      harness: settings.harness,
      transcription: settings.transcription,
      keys: { groq: !!getCredential("groq"), exa: !!getCredential("exa"), fal: !!getCredential("fal"), firecrawl: !!getCredential("firecrawl") },
      local: await localStatus().catch(() => ({ installed: false, model: "unavailable" as const })),
      searchModel: existsSync(SEARCH_MODEL) ? "present" : (searchState.__mlchSearchModel ?? "missing"),
      vaults: obsidianVaults().filter((vault) => !linked.has(vault.path)),
    };
  });
}

/** {action: "downloads"} starts both models' downloads; {action: "done"} finishes the first-run screen. */
export async function POST(request: Request) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  if (body.action === "downloads") {
    return handle(async () => {
      startSearchDownload();
      const local = await localStatus().catch(() => undefined);
      if (local?.installed && local.model === "missing") await downloadModel().catch((error) => log.warn("onboarding", "model download failed", { error }));
      return { ok: true };
    });
  }
  if (body.action === "done") return handle(async () => (await writeSettings({ onboarded: true }), { ok: true }));
  return jsonError(400, 'action is "downloads" or "done".');
}
