"use client";

import { Check } from "lucide-react";
import type { AgentHarnessId } from "@/lib/agent/types";
import { KeyField } from "./KeyField";

export type AuthMode = "subscription" | "apiKey";

const NAMES: Record<AgentHarnessId, { app: string; plan: string; key: string; keyName: "anthropic" | "openai"; url: string }> = {
  claude: { app: "Claude Code", plan: "Claude", key: "Anthropic", keyName: "anthropic", url: "https://console.anthropic.com/settings/keys" },
  codex: { app: "Codex", plan: "ChatGPT", key: "OpenAI", keyName: "openai", url: "https://platform.openai.com/api-keys" },
};

/**
 * How one AI is paid for: the person's own subscription (their Claude Code /
 * Codex, signed in on this Mac; confirmed with a checkbox) or an API key.
 * Wording is placeholder (George).
 */
export function AiAccess({
  id,
  mode,
  consented,
  onChange,
}: {
  id: AgentHarnessId;
  mode: AuthMode;
  consented: boolean;
  onChange: (patch: { agentAuth?: AuthMode; consent?: boolean } | { keySaved: true }) => void;
}) {
  const names = NAMES[id];
  const chip = (on: boolean) => `h-7 px-2.5 rounded-full text-[12.5px] inline-flex items-center gap-1 ${on ? "border-[1.5px] border-ink text-ink font-medium" : "border border-line text-ink-3 hover:border-line-2 hover:text-ink"}`;
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {(["subscription", "apiKey"] as const).map((choice) => (
          <button key={choice} aria-pressed={mode === choice} onClick={() => onChange({ agentAuth: choice })} className={chip(mode === choice)}>
            {mode === choice && <Check size={12} strokeWidth={2.25} />}
            {choice === "subscription" ? `My ${names.plan} subscription` : `${names.key} API key`}
          </button>
        ))}
      </div>
      {mode === "subscription" ? (
        <label className="flex items-start gap-2 text-[13px] text-ink-2 max-w-[520px]">
          <input type="checkbox" checked={consented} onChange={(e) => onChange({ consent: e.target.checked })} className="mt-0.5 accent-black" />
          <span>
            I use my own {names.app}, installed, paid for and signed in on this Mac. mlch runs it here, on my machine, and what it does counts against my {names.plan} plan. I am responsible for that use.
          </span>
        </label>
      ) : (
        <KeyField name={names.keyName} label={names.key} url={names.url} onChanged={() => onChange({ keySaved: true })} />
      )}
    </div>
  );
}
