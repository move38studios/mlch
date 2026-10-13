import { handle, jsonError } from "@/lib/http";
import { DEFAULT_MODELS, readSettings, writeSettings } from "@/lib/settings";
import { getCredential, isDesktop } from "@/lib/desktop/server";
import { usageToday } from "@/lib/agent/usage";
import { spentToday } from "@/lib/media/spend";
import { PROMPT_DEFAULTS } from "@/lib/agent/prompts";

export const dynamic = "force-dynamic";

async function view() {
  return {
    settings: await readSettings(),
    // Whether a key is available (stored in the app or in .env.local); never the key.
    keys: { groq: !!getCredential("groq"), firecrawl: !!getCredential("firecrawl"), fal: !!getCredential("fal"), exa: !!getCredential("exa"), gemini: !!getCredential("gemini"), anthropic: !!getCredential("anthropic"), openai: !!getCredential("openai") },
    spentToday: await spentToday(),
    usageToday: await usageToday(),
    desktop: isDesktop(),
    defaults: DEFAULT_MODELS,
    promptDefaults: PROMPT_DEFAULTS,
  };
}

export async function GET() {
  return handle(view);
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError(400, "Invalid settings.");
  return handle(async () => {
    await writeSettings(body);
    return view();
  });
}
