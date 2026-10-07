import { handle, jsonError } from "@/lib/http";
import { DEFAULT_MODELS, readSettings, writeSettings } from "@/lib/settings";
import { getCredential, isDesktop } from "@/lib/desktop/server";

export const dynamic = "force-dynamic";

async function view() {
  return {
    settings: await readSettings(),
    // Whether a key is available (stored in the app or in .env.local); never the key.
    keys: { groq: !!getCredential("groq"), firecrawl: !!getCredential("firecrawl") },
    desktop: isDesktop(),
    defaults: DEFAULT_MODELS,
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
