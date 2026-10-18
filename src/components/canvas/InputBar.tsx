"use client";

import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { useMulch } from "@/lib/mulch/client";
import { useCanvasUi } from "./ui";
import { pendingTurn } from "./turn";
import { CallButton, MicButton, TranscriptStrip } from "./Mic";
import { HoldToTalk } from "./HoldToTalk";

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request failed (${response.status})`);
  }
}

/**
 * Typing into the mulch. Text goes through the fast lane like speech, which
 * tells thinking from instructions. ⌘↩, or a leading "/", sends it straight
 * to the command lane as an instruction.
 */
export function InputBar({ mulchId, children }: { mulchId: string; children?: React.ReactNode }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // Comments and notes since the last instruction go with the next one; with nothing typed, they are the instruction.
  const pending = useMulch((s) => pendingTurn(s.mulch, s.jobs).label);

  async function send(forceInstruction = false) {
    let value = text.trim();
    const typedNothing = !value && !!pending;
    const instruction = forceInstruction || value.startsWith("/") || typedNothing;
    if (value.startsWith("/")) value = value.slice(1).trim();
    if (typedNothing) value = pending;
    if (!value || sending) return;
    setSending(true);
    try {
      if (instruction) await post(`/api/mulches/${mulchId}/command`, { instruction: value, about: useCanvasUi.getState().selectedIds });
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
      <HoldToTalk mulchId={mulchId} />
      <TranscriptStrip />
      {pending && (
        <div className="flex justify-center mb-1.5">
          <button
            onClick={() => void send(true)}
            disabled={sending}
            className="float rounded-full h-7 px-3 text-[12.5px] text-ink-2 hover:text-ink inline-flex items-center gap-1.5"
            title="Send"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-ink" />
            {pending}
          </button>
        </div>
      )}
      <div className="float flex items-center gap-2 rounded-2xl pl-2 pr-2 py-2">
        <MicButton mulchId={mulchId} />
        <CallButton mulchId={mulchId} />
        {children}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(e.metaKey || e.ctrlKey);
            }
          }}
          rows={1}
          placeholder="Type"
          aria-label="Input"
          className="flex-1 min-w-0 resize-none bg-transparent outline-none focus-visible:outline-none px-1.5 py-2 text-[15.5px] leading-[1.35] max-h-40 field-sizing-content placeholder:text-ink-3"
        />
        <button
          onClick={() => void send()}
          disabled={(!text.trim() && !pending) || sending}
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
