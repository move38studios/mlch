"use client";

import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { useMulch } from "@/lib/mulch/client";
import { MicButton, TranscriptStrip } from "./Mic";

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request failed (${response.status})`);
  }
}

/**
 * Typing into the mulch. "Thought" goes through the fast lane like speech;
 * "Instruction" goes straight to the command lane.
 */
export function InputBar({ mulchId, children }: { mulchId: string; children?: React.ReactNode }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"thought" | "instruction">("thought");
  const [sending, setSending] = useState(false);

  async function send() {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      if (mode === "instruction") await post(`/api/mulches/${mulchId}/command`, { instruction: value });
      else await post(`/api/mulches/${mulchId}/input`, { text: value });
      setText("");
    } catch (error) {
      useMulch.setState({ notice: { level: "error", message: (error as Error).message, at: Date.now() } });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 w-[min(700px,calc(100%-360px))] min-w-[380px]">
      <TranscriptStrip />
      <div className="float flex items-center gap-2 rounded-2xl pl-2 pr-2 py-2">
        <MicButton mulchId={mulchId} />
        {children}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={mode === "thought" ? "Type" : "Instruction"}
          aria-label="Input"
          className="flex-1 min-w-0 resize-none bg-transparent outline-none px-1.5 py-2 text-[15.5px] leading-[1.35] max-h-40 field-sizing-content placeholder:text-ink-3"
        />
        <div className="flex shrink-0 rounded-lg bg-paper-2 p-0.5 text-[12.5px]" role="group" aria-label="Mode">
          {(["thought", "instruction"] as const).map((value) => (
            <button
              key={value}
              onClick={() => setMode(value)}
              aria-pressed={mode === value}
              className={`px-2 py-1 rounded-md ${mode === value ? "bg-chrome text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-ink-3 hover:text-ink"}`}
            >
              {value === "thought" ? "Thought" : "Instruction"}
            </button>
          ))}
        </div>
        <button
          onClick={send}
          disabled={!text.trim() || sending}
          aria-label="Send"
          title="Send"
          className="shrink-0 h-10 w-10 grid place-items-center rounded-xl bg-ink text-white disabled:bg-paper-2 disabled:text-ink-3"
        >
          <ArrowUp size={18} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
