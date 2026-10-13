import { guardAgent, handle, jsonError } from "@/lib/http";
import { accountView, billingUrl, checkOwnServer, finishSignIn, serverAddress, shareTarget, signInUrl, signOut } from "@/lib/share/account";
import { ShareError } from "@/lib/share/client";
import { readSettings, writeSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Settings, Sharing: where shares go, and the mlch.app account (never the session or key). */
async function view() {
  const settings = await readSettings();
  const target = await shareTarget(settings);
  return {
    mode: settings.sharing,
    server: settings.shareServer ?? null,
    ownKey: !!(settings.sharing === "own" && target.auth),
    account: settings.sharing === "mlch" ? await accountView() : undefined,
  };
}

export type SharingView = Awaited<ReturnType<typeof view>>;

export async function GET() {
  return handle(view);
}

/**
 * POST { action }:
 *   mode { mode, server? }   choose mlch.app, off, or an own server (its key is saved through the desktop shell)
 *   check-server             an own server: is it there, is the key right
 *   sign-in                  → { url } to open in the browser
 *   finish { code }          from main, after mlch://signed-in
 *   checkout | portal        → { url }: Stripe Checkout, or the billing page
 *   sign-out
 */
export async function POST(request: Request) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { action?: string; mode?: string; server?: string; code?: string };
  return handle(async () => {
    try {
      switch (body.action) {
        case "mode": {
          if (body.mode !== "mlch" && body.mode !== "off" && body.mode !== "own") return jsonError(400, 'mode is "mlch", "off" or "own".');
          let server: string | undefined;
          if (body.mode === "own" && body.server !== undefined) {
            server = serverAddress(body.server);
            if (!server) return jsonError(400, "Enter the server's address, starting with https://.");
          }
          await writeSettings({ sharing: body.mode, ...(server ? { shareServer: server } : {}) });
          return view();
        }
        case "check-server": {
          const target = await shareTarget();
          if (target.mode !== "own" || !target.base) return jsonError(400, "Enter the server's address first.");
          const result = await checkOwnServer(target.base, target.auth);
          return result.ok ? { ok: true } : jsonError(400, result.error);
        }
        case "sign-in":
          return { url: signInUrl() };
        case "finish":
          if (typeof body.code !== "string") return jsonError(400, "Give the code.");
          await finishSignIn(body.code);
          return view();
        case "checkout":
        case "portal":
          return { url: await billingUrl(body.action) };
        case "sign-out":
          await signOut();
          return view();
        default:
          return jsonError(400, "Unknown action.");
      }
    } catch (error) {
      if (error instanceof ShareError) return jsonError(error.status >= 400 && error.status < 500 ? error.status : 502, error.message);
      throw error;
    }
  });
}
