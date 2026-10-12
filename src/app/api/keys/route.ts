import { guardAgent, handle, jsonError } from "@/lib/http";
import { getCredential } from "@/lib/desktop/server";
import { checkKey, KEY_NAMES, keyHint, type KeyName } from "@/lib/keys/check";

export const dynamic = "force-dynamic";

/** Each key: whether one is available and its last four characters. Never the key. */
export async function GET() {
  return handle(async () => ({ keys: Object.fromEntries(KEY_NAMES.map((name) => [name, { set: !!getCredential(name), hint: keyHint(name) }])) }));
}

/**
 * POST {name, hint}: checks the saved key with the service. The page saves keys
 * through the desktop shell, which passes them to this process a moment later;
 * `hint` (the new key's last four characters) waits for that one.
 */
export async function POST(request: Request) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; hint?: unknown };
  const name = KEY_NAMES.find((n) => n === body.name) as KeyName | undefined;
  if (!name) return jsonError(400, `name is one of ${KEY_NAMES.join(", ")}.`);
  const hint = typeof body.hint === "string" ? body.hint : undefined;
  return handle(async () => {
    for (let i = 0; i < 30 && hint && !getCredential(name)?.endsWith(hint); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const key = getCredential(name);
    if (!key) return { ok: false, error: "No key saved." };
    return checkKey(name, key);
  });
}
