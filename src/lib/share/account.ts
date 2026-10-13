/**
 * Where this app shares to, and the mlch.app account. Server-only: the
 * session and a self-hosted server's key stay out of the page.
 *
 * Settings → Sharing (settings.sharing):
 *   mlch  mlch.app: sign in with Google, $12 a year to make new shares
 *   off   no Share buttons; nothing is sent
 *   own   the person's own mlch server (cloud/, `npm run deploy:own`): its address and key
 *
 * Sign-in: `signInUrl()` keeps a verifier and gives the page the address to
 * open in the browser; mlch.app sends the person back to mlch://signed-in
 * with a grant, main posts it here (`finishSignIn`), and the session goes to
 * Keychain through main (bridge "account-token").
 */

import { createHash, randomBytes } from "node:crypto";
import { desktopRequest, getCredential, isDesktop } from "@/lib/desktop/server";
import { log } from "@/lib/log";
import { readSettings, type Settings } from "@/lib/settings";
import { DEFAULT_SHARE_URL, ShareError } from "./client";

export type SharingMode = Settings["sharing"];

export interface ShareTarget {
  mode: SharingMode;
  /** The server's origin; undefined when sharing is off (or no own server is set). */
  base?: string;
  /** Sent as X-Mlch-Auth when making a new share: the session, or the own server's key. */
  auth?: string;
}

export interface AccountView {
  signedIn: boolean;
  email?: string;
  canShare?: boolean;
  subscription?: { status: string; periodEnd: number | null } | null;
  /** Why the account could not be read (offline, signed out elsewhere). */
  error?: string;
}

const state = globalThis as typeof globalThis & { __mlchSignIn?: { verifier: string; at: number }; __mlchAccountToken?: string | null };

export const mlchServer = () => (process.env.MLCH_SHARE_URL ?? DEFAULT_SHARE_URL).replace(/\/+$/, "");

/** A server address the person typed: https, or http on this Mac (development). */
export function serverAddress(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function sessionToken(): string | undefined {
  // In the browser dev server there is no Keychain: the session lives in memory until restart.
  if (!isDesktop() && state.__mlchAccountToken !== undefined) return state.__mlchAccountToken ?? undefined;
  return getCredential("mlchAccount");
}

async function storeSession(token: string | null): Promise<void> {
  if (!isDesktop()) {
    state.__mlchAccountToken = token;
    return;
  }
  const result = await desktopRequest("account-token", { token });
  if (!result.ok) throw new ShareError(500, result.error);
  // Main posts the stored keys to this process; wait for them so the next request has the session.
  for (let i = 0; i < 20 && (getCredential("mlchAccount") ?? null) !== token; i++) await new Promise((r) => setTimeout(r, 50));
}

export async function shareTarget(settings?: Settings): Promise<ShareTarget> {
  const s = settings ?? (await readSettings());
  if (s.sharing === "off") return { mode: "off" };
  if (s.sharing === "own") {
    const base = s.shareServer ? serverAddress(s.shareServer) : undefined;
    return { mode: "own", base, auth: getCredential("shareKey") };
  }
  return { mode: "mlch", base: mlchServer(), auth: sessionToken() };
}

async function call<T>(path: string, init: RequestInit = {}, token = sessionToken()): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${mlchServer()}${path}`, { ...init, headers });
  } catch {
    throw new ShareError(502, "mlch.app could not be reached.");
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ShareError(response.status, body.error || `mlch.app answered ${response.status}.`);
  return body;
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** The address to open in the browser to sign in. */
export function signInUrl(): string {
  const verifier = base64url(randomBytes(32));
  state.__mlchSignIn = { verifier, at: Date.now() };
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  // A local test server signs in without Google (cloud: npm run dev).
  const local = /^http:\/\/(localhost|127\.0\.0\.1)/.test(mlchServer()) && process.env.MLCH_DEV_SIGN_IN;
  return local ? `${mlchServer()}/auth/dev?email=${encodeURIComponent(process.env.MLCH_DEV_SIGN_IN!)}&challenge=${challenge}` : `${mlchServer()}/auth/google?challenge=${challenge}`;
}

export async function finishSignIn(code: string): Promise<void> {
  const pending = state.__mlchSignIn;
  if (!pending || Date.now() - pending.at > 10 * 60_000) throw new ShareError(400, "This sign-in has expired. Sign in again.");
  const { token } = await call<{ token: string }>("/api/account/token", { method: "POST", body: JSON.stringify({ code, verifier: pending.verifier }) }, undefined);
  state.__mlchSignIn = undefined;
  await storeSession(token);
  log.info("share", "Signed in to mlch.app");
}

export async function accountView(): Promise<AccountView> {
  if (!sessionToken()) return { signedIn: false };
  try {
    const account = await call<{ email: string; canShare: boolean; subscription: AccountView["subscription"] }>("/api/account");
    return { signedIn: true, email: account.email, canShare: account.canShare, subscription: account.subscription };
  } catch (error) {
    if (error instanceof ShareError && error.status === 401) {
      await storeSession(null);
      return { signedIn: false };
    }
    return { signedIn: true, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Stripe Checkout (or, when already subscribed, the billing page), to open in the browser. */
export async function billingUrl(which: "checkout" | "portal"): Promise<string> {
  return (await call<{ url: string }>(`/api/account/${which}`, { method: "POST" })).url;
}

export async function signOut(): Promise<void> {
  await call("/api/account/signout", { method: "POST" }).catch(() => undefined);
  await storeSession(null);
}

/** Checks an own server: that it is an mlch server and that the key is right. */
export async function checkOwnServer(base: string, key: string | undefined): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const info = (await (await fetch(`${base}/api/server`)).json().catch(() => ({}))) as { mlch?: number; auth?: string };
    if (info.mlch !== 1) return { ok: false, error: "No mlch server at that address." };
    if (info.auth === "none") return { ok: true };
    if (!key) return { ok: false, error: "Enter the server's key." };
    // A share with nothing in it is refused for its content (400) only once the key is right.
    const probe = await fetch(`${base}/api/shares`, { method: "POST", headers: { "Content-Type": "application/json", "X-Mlch-Auth": key }, body: "{}" });
    return probe.status === 400 ? { ok: true } : { ok: false, error: "The server did not accept that key." };
  } catch {
    return { ok: false, error: "That address could not be reached." };
  }
}
