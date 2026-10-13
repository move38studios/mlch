/**
 * Keys for outside services: whether one works, checked with a free request
 * (listing models, credit usage) that fails only for a wrong key. Server-only.
 */

import { getCredential, type CredentialName } from "@/lib/desktop/server";

export type KeyName = CredentialName;
export const KEY_NAMES: KeyName[] = ["groq", "exa", "fal", "firecrawl", "gemini", "anthropic", "openai"];

export type KeyCheck = { ok: true } | { ok: false; error: string };

const CHECKS: Record<KeyName, (key: string) => { url: string; headers: Record<string, string> }> = {
  groq: (key) => ({ url: "https://api.groq.com/openai/v1/models", headers: { Authorization: `Bearer ${key}` } }),
  openai: (key) => ({ url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${key}` } }),
  anthropic: (key) => ({ url: "https://api.anthropic.com/v1/models?limit=1", headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }),
  firecrawl: (key) => ({ url: "https://api.firecrawl.dev/v2/team/credit-usage", headers: { Authorization: `Bearer ${key}` } }),
  fal: (key) => ({ url: "https://api.fal.ai/v1/models?limit=1", headers: { Authorization: `Key ${key}` } }),
  gemini: (key) => ({ url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: { "x-goog-api-key": key } }),
  // Websets answers a wrong key with "Invalid API key" and a good key without that plan with "does not have access": both free.
  exa: (key) => ({ url: "https://api.exa.ai/websets/v0/websets?limit=1", headers: { "x-api-key": key } }),
};

/** The last four characters of a saved key, to recognise it by; never more. */
export function keyHint(name: KeyName): string | undefined {
  const key = getCredential(name);
  return key && key.length > 8 ? key.slice(-4) : undefined;
}

export async function checkKey(name: KeyName, key: string, fetcher: typeof fetch = fetch): Promise<KeyCheck> {
  const { url, headers } = CHECKS[name](key);
  let response: Response;
  try {
    response = await fetcher(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    return { ok: false, error: "Could not reach the service to check the key. It is saved; try again when online." };
  }
  if (response.ok) return { ok: true };
  const body = await response.text().catch(() => "");
  if (name === "exa" && response.status === 401 && !/invalid api key/i.test(body)) return { ok: true };
  // Google answers a wrong key with 400 ("API key not valid").
  if (response.status === 401 || response.status === 403 || (response.status === 400 && /api.?key/i.test(body))) return { ok: false, error: "The service does not accept this key." };
  return { ok: false, error: `The service answered ${response.status}; the key may still work.` };
}
