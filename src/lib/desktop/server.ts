/**
 * The desktop shell, as route code sees it. Server-only.
 *
 * Under Electron, electron/server.cjs puts stored keys and the native bridge
 * on globalThis. In a plain browser dev server (`npm run dev`) neither exists:
 * keys come from .env.local and native requests fail.
 */

import os from "node:os";
import path from "node:path";

export type CredentialName = "groq" | "firecrawl" | "fal" | "exa";

const ENV_NAMES: Record<CredentialName, string> = {
  groq: "GROQ_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  fal: "FAL_KEY",
  exa: "EXA_API_KEY",
};

type DesktopGlobals = typeof globalThis & {
  __mulchCredentials?: Partial<Record<CredentialName, string | null>>;
  __mulchDesktop?: { request(type: string, payload?: Record<string, unknown>): Promise<BridgeResult> };
};

export type BridgeResult = { ok: true; value?: unknown } | { ok: false; error: string };

/** A key stored in the app, else the environment. Undefined when neither has one. */
export function getCredential(name: CredentialName): string | undefined {
  const stored = (globalThis as DesktopGlobals).__mulchCredentials?.[name];
  if (typeof stored === "string" && stored) return stored;
  const fromEnv = process.env[ENV_NAMES[name]];
  return fromEnv ? fromEnv : undefined;
}

export function isDesktop(): boolean {
  return process.env.MULCH_ELECTRON === "1";
}

export async function desktopRequest(type: "reveal" | "open" | "choose-directory" | "render", payload?: Record<string, unknown>): Promise<BridgeResult> {
  const bridge = (globalThis as DesktopGlobals).__mulchDesktop;
  if (!bridge) return { ok: false, error: "Only available in the desktop app." };
  return bridge.request(type, payload);
}

/** Where napkin folders live. */
export function libraryDir(): string {
  return process.env.MULCH_LIBRARY ? path.resolve(process.env.MULCH_LIBRARY) : path.join(os.homedir(), "Documents", "Mulch");
}
