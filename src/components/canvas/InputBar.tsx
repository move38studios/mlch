"use client";

import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { useNapkin } from "@/lib/napkin/client";
import { MicButton, TranscriptStrip } from "./Mic";

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request failed (${response.status})`);
  }
}

/**
 * Typing into the napkin. "Thought" goes through the fast lane like speech;
 * "Instruction" goes straight to the command lane.
 */
export function InputBar({ napkinId, children }: { napkinId: string; children?: React.ReactNode }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"thought" | "instruction">("thought");
  const [sending, setSending] = useState(false);

  async function send() {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      if (mode === "instruction") await post(`/api/napkins/${napkinId}/command`, { instruction: value });
      else await post(`/api/napkins/${napkinId}/input`, { text: value });
      setText("");
    } catch (error) {
      useNapkin.setState({ notice: { level: "error", message: (error as Error).message, at: Date.now() } });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 w-[min(680px,calc(100%-380px))] min-w-[360px]">
      <TranscriptStrip />
      <div className="flex items-end gap-2 rounded-xl border border-line bg-white/95 backdrop-blur shadow-lg px-2 py-2">
        <MicButton napkinId={napkinId} />
        {children}
        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex gap-1 px-1 pb-1 text-[11px]">
            {(["thought", "instruction"] as const).map((value) => (
              <button
                key={value}
                onClick={() => setMode(value)}
                className={`px-1.5 py-0.5 rounded ${mode === value ? "bg-ink text-paper" : "text-ink-3 hover:text-ink"}`}
              >
                {value === "thought" ? "Thought" : "Instruction"}
              </button>
            ))}
          </div>
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
            placeholder="Type"
            aria-label="Input"
            className="w-full resize-none bg-transparent outline-none px-1 text-[15px] max-h-40 field-sizing-content"
          />
        </div>
        <button
          onClick={send}
          disabled={!text.trim() || sending}
          aria-label="Send"
          title="Send"
          className="shrink-0 h-9 w-9 grid place-items-center rounded-lg bg-ink text-paper disabled:opacity-25"
        >
          <ArrowUp size={17} />
        </button>
      </div>
    </div>
  );
}
