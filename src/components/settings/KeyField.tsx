"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { desktop } from "@/lib/desktop/client";

export type KeyName = "groq" | "exa" | "fal" | "firecrawl" | "gemini" | "anthropic" | "openai";

const PRIMARY = "h-8 px-3 rounded-lg bg-ink text-white text-[13px] font-medium disabled:bg-paper-2 disabled:text-ink-3";
const SECONDARY = "h-8 px-2.5 rounded-lg text-[13px] text-ink-2 hover:bg-paper-2 hover:text-ink inline-flex items-center shrink-0";
const FIELD = "h-9 flex-1 min-w-0 rounded-lg border border-line bg-chrome px-3 text-[13.5px] outline-none focus:border-ink";

type Check = { state: "idle" } | { state: "checking" } | { state: "ok" } | { state: "failed"; error: string };

/**
 * One key for an outside service: saved through the desktop shell (Keychain),
 * shown by its last four characters, checked with the service when saved,
 * changed or removed. Wording is placeholder (George).
 */
export function KeyField({ name, label, url, onChanged }: { name: KeyName; label: string; url?: string; onChanged?: () => void }) {
  const [info, setInfo] = useState<{ set: boolean; hint?: string; stored: boolean }>();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const [error, setError] = useState<string>();
  const bridge = desktop();

  const load = useCallback(async () => {
    const [keys, stored] = await Promise.all([
      fetch("/api/keys").then((r) => r.json() as Promise<{ keys: Record<KeyName, { set: boolean; hint?: string }> }>),
      bridge?.credentials.status(),
    ]);
    setInfo({ ...keys.keys[name], stored: !!(stored?.ok && stored.value[name]) });
  }, [bridge, name]);
  useEffect(() => void load(), [load]);

  async function verify(hint?: string) {
    setCheck({ state: "checking" });
    const response = await fetch("/api/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, hint }) });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setCheck(body.ok ? { state: "ok" } : { state: "failed", error: body.error ?? "Could not check the key." });
    await load();
  }
  async function save() {
    const key = value.trim();
    if (!key || !bridge) return;
    const result = await bridge.credentials.write({ [name]: key });
    if (!result.ok) return setError(result.error);
    setError(undefined);
    setValue("");
    setEditing(false);
    onChanged?.();
    await verify(key.slice(-4));
    onChanged?.();
  }
  async function remove() {
    const result = await bridge?.credentials.delete(name);
    if (result && !result.ok) return setError(result.error);
    setCheck({ state: "idle" });
    await load();
    onChanged?.();
  }

  if (!info) return <div className="h-9" />;
  if (info.set && !editing) {
    return (
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-[13.5px] text-ink">
            <span className="h-[18px] w-[18px] rounded-full bg-ink text-white grid place-items-center">
              <Check size={11} strokeWidth={3} />
            </span>
            {info.stored ? (info.hint ? `Saved, ending in ${info.hint}` : "Saved") : "From .env.local"}
          </span>
          {check.state === "checking" && (
            <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-3">
              <Loader2 className="animate-spin" size={12} /> Checking
            </span>
          )}
          {check.state === "ok" && <span className="text-[12.5px] text-ink-2">Works</span>}
          <span className="flex-1" />
          {check.state !== "checking" && (
            <button onClick={() => void verify()} className={SECONDARY}>
              Check
            </button>
          )}
          {bridge && (
            <button onClick={() => setEditing(true)} className={SECONDARY}>
              Change
            </button>
          )}
          {bridge && info.stored && (
            <button onClick={() => void remove()} className={SECONDARY}>
              Remove
            </button>
          )}
        </div>
        {check.state === "failed" && <p className="mt-1.5 text-[12.5px] text-danger">{check.error}</p>}
        {error && <p className="mt-1.5 text-[12.5px] text-danger">{error}</p>}
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          type="password"
          placeholder={`${label} API key`}
          aria-label={`${label} API key`}
          autoFocus={editing}
          className={FIELD}
          disabled={!bridge}
        />
        <button onClick={() => void save()} disabled={!value.trim() || !bridge} className={PRIMARY}>
          Save
        </button>
        {editing ? (
          <button onClick={() => setEditing(false)} className={SECONDARY}>
            Cancel
          </button>
        ) : (
          url && (
            <a href={url} target="_blank" rel="noreferrer" className={SECONDARY}>
              Get a key
            </a>
          )
        )}
      </div>
      {!bridge && <p className="mt-1.5 text-[12.5px] text-ink-3">Keys are saved in the desktop app; here they come from .env.local.</p>}
      {error && <p className="mt-1.5 text-[12.5px] text-danger">{error}</p>}
    </div>
  );
}
