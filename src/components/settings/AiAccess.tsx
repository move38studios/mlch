"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import type { AgentHarnessId } from "@/lib/agent/types";
import { desktop } from "@/lib/desktop/client";

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
  keySaved,
  onChange,
}: {
  id: AgentHarnessId;
  mode: AuthMode;
  consented: boolean;
  keySaved: boolean;
  onChange: (patch: { agentAuth?: AuthMode; consent?: boolean } | { keySaved: true }) => void;
}) {
  const names = NAMES[id];
  const [value, setValue] = useState("");
  async function save() {
    if (!value.trim()) return;
    await desktop()?.credentials.write({ [names.keyName]: value.trim() });
    setValue("");
    onChange({ keySaved: true });
  }
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
      ) : keySaved ? (
        <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
          <Check size={13} strokeWidth={2.25} /> Key saved
          <button onClick={() => void desktop()?.credentials.delete(names.keyName).then(() => onChange({ agentAuth: "apiKey" }))} className="ml-2 text-ink-3 hover:text-ink underline underline-offset-2">
            Remove
          </button>
        </span>
      ) : (
        <div className="flex items-center gap-2 max-w-[520px]">
          <input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} type="password" placeholder={`${names.key} API key`} aria-label={`${names.key} API key`} className="h-8 flex-1 min-w-0 rounded-lg border border-line bg-chrome px-2.5 text-[13.5px] outline-none focus:border-ink" />
          <button onClick={() => void save()} disabled={!value.trim()} className="h-8 px-3 rounded-lg bg-ink text-white text-[13px] font-medium disabled:bg-paper-2 disabled:text-ink-3">
            Save
          </button>
          <a href={names.url} target="_blank" rel="noreferrer" className="h-8 px-2.5 rounded-lg text-[13px] text-ink-2 hover:bg-paper-2 hover:text-ink inline-flex items-center shrink-0">
            Get a key
          </a>
        </div>
      )}
    </div>
  );
}
