/**
 * mlch: the person's own Claude Code setup in mlch's turns. Server-only.
 *
 * Turns load the person's user settings (CLAUDE.md, hooks, plugins, MCP
 * servers, claude.ai connectors), so mlch works like their Claude Code. One
 * thing is overridden: who pays. A user setting can make Claude Code pay
 * with an API key (`apiKeyHelper`, or a key in its `env`), so every turn
 * lays flag settings on top that switch those off, and Claude Code falls
 * back to the subscription login. Tested with Claude Code 2.1.300:
 * `apiKeyHelper: ""` stops a helper (null does not), an empty string stops
 * an env variable. The event mapper's API-key check stays as the backstop.
 * docs/research/connectors.md.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Settings `env` names that choose who pays or where requests go. Model names are left alone. */
const BILLING_ENV = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS|BEDROCK_|VERTEX_|FOUNDRY_)|CLAUDE_CODE_USE_|CLAUDE_CODE_API_KEY|CLAUDE_CODE_GATEWAY_|AWS_BEARER_TOKEN_BEDROCK)/;

/** Always blanked, whether or not the settings file names them. */
const ALWAYS_BLANK = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

export function isBillingEnv(name: string): boolean {
  return BILLING_ENV.test(name);
}

/** The billing-relevant parts of the person's Claude Code user settings. */
export interface ClaudeUserBilling {
  apiKeyHelper: boolean;
  /** Billing variables in the settings' `env`. */
  env: string[];
}

function settingsFile(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, "settings.json");
}

export function readClaudeUserBilling(env: Record<string, string | undefined> = process.env): ClaudeUserBilling {
  let parsed: { apiKeyHelper?: unknown; env?: unknown } = {};
  try {
    parsed = JSON.parse(readFileSync(settingsFile(env), "utf8")) as typeof parsed;
  } catch {
    // No settings, or unreadable: nothing to override beyond the fixed list.
  }
  const names = parsed.env && typeof parsed.env === "object" ? Object.keys(parsed.env as object) : [];
  return {
    apiKeyHelper: typeof parsed.apiKeyHelper === "string" && parsed.apiKeyHelper.trim() !== "",
    env: names.filter(isBillingEnv),
  };
}

/** Flag settings that keep a turn on the subscription whatever the user settings say. */
export function subscriptionOverrides(billing: ClaudeUserBilling): { apiKeyHelper: string; env: Record<string, string> } {
  const names = [...new Set([...ALWAYS_BLANK, ...billing.env])];
  return { apiKeyHelper: "", env: Object.fromEntries(names.map((name) => [name, ""])) };
}

/** What the settings panel says when Claude Code is set to pay with an API key that mlch ignores. Wording is placeholder (George). */
export function apiKeyNotice(billing: ClaudeUserBilling): string | undefined {
  const where = billing.apiKeyHelper ? "an apiKeyHelper" : billing.env.length ? billing.env.join(", ") : undefined;
  if (!where) return undefined;
  return `Claude Code's settings use an API key (${where}). mlch uses your Claude subscription instead. To pay with an API key, choose Anthropic API key below.`;
}

/** `mcp__<server>__<tool>` → the tool's own name. */
export function mcpToolName(toolName: string): string {
  const parts = toolName.split("__");
  return parts.length >= 3 ? parts.slice(2).join("__") : toolName;
}
