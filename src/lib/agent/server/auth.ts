/**
 * How an AI is paid for, per harness. Server-only.
 *
 * "subscription": the person's own Claude Code / Codex login on this Mac,
 * guarded so it never bills API credits or extra usage (billing.ts).
 * "apiKey": the person chose an API key (Keychain) instead; turns are billed
 * to their API account, so the subscription guards do not apply.
 */

import { getCredential } from "@/lib/desktop/server";
import { readSettings } from "@/lib/settings";
import type { AgentHarnessId } from "../types";

export type AgentAuth = { mode: "subscription" } | { mode: "apiKey"; key?: string };

const KEY_NAME = { claude: "anthropic", codex: "openai" } as const;

export async function agentAuth(id: AgentHarnessId): Promise<AgentAuth> {
  const settings = await readSettings().catch(() => undefined);
  if (settings?.agentAuth[id] !== "apiKey") return { mode: "subscription" };
  const key = getCredential(KEY_NAME[id]);
  return key ? { mode: "apiKey", key } : { mode: "apiKey" };
}

/** mlch: whether turns may use the person's own CLI setup (Settings → AI; on unless turned off). */
export async function useAgentSetup(): Promise<boolean> {
  const settings = await readSettings().catch(() => undefined);
  return settings?.agentSetup ?? true;
}

export const API_KEY_MISSING: Record<AgentHarnessId, string> = {
  claude: "No Anthropic API key. Add it in Settings → AI, or switch to your Claude subscription.",
  codex: "No OpenAI API key. Add it in Settings → AI, or switch to your ChatGPT subscription.",
};
