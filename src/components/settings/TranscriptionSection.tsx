"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

type Choice = "groq" | "local";
interface LocalStatus {
  installed: boolean;
  model: "unavailable" | "missing" | "downloading" | "present";
  progress?: number;
  error?: string;
}

const CHOICES: Array<{ id: Choice; label: string }> = [
  { id: "groq", label: "Groq" },
  { id: "local", label: "Local" },
];

/** Groq or Parakeet on this Mac. Choosing local downloads its model (about 600 MB) if needed. */
export function TranscriptionChoice({ value, onChange }: { value: Choice; onChange: (next: Choice) => void }) {
  const [status, setStatus] = useState<LocalStatus>();

  const load = useCallback(async () => {
    const response = await fetch("/api/transcription").catch(() => undefined);
    if (response?.ok) setStatus((await response.json()) as LocalStatus);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Follow a download until it ends.
  useEffect(() => {
    if (status?.model !== "downloading") return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [status?.model, load]);

  async function download() {
    const response = await fetch("/api/transcription", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "download" }) });
    if (response.ok) setStatus((await response.json()) as LocalStatus);
  }

  async function choose(next: Choice) {
    onChange(next);
    if (next === "local" && status?.model === "missing") await download();
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {CHOICES.map((item) => {
          const on = value === item.id;
          const disabled = item.id === "local" && !status?.installed;
          return (
            <button
              key={item.id}
              aria-pressed={on}
              disabled={disabled}
              onClick={() => void choose(item.id)}
              className={`h-8 px-3 rounded-full text-[13px] inline-flex items-center gap-1.5 disabled:opacity-40 ${on ? "border-[1.5px] border-ink text-ink font-medium" : "border border-line text-ink-3 hover:border-line-2 hover:text-ink"}`}
            >
              {on && <Check size={13} strokeWidth={2.25} />}
              {item.label}
            </button>
          );
        })}
      </div>
      {value === "local" && status?.model === "downloading" && (
        <p className="mt-2 text-[13px] text-ink-3 inline-flex items-center gap-2">
          <Loader2 size={13} className="animate-spin motion-reduce:animate-none" /> Downloading model {Math.round((status.progress ?? 0) * 100)}%
        </p>
      )}
      {value === "local" && status?.model === "missing" && (
        <div className="mt-2 flex items-center gap-2">
          <button onClick={() => void download()} className="h-8 px-3 rounded-lg bg-ink text-white text-[13px] font-medium">
            Download model
          </button>
          {status.error && <span className="text-[12.5px] text-danger">{status.error}</span>}
        </div>
      )}
    </div>
  );
}
