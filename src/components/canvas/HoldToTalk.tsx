"use client";

import { useEffect, useRef, useState } from "react";
import { Scribble } from "@/components/brand/Scribble";
import { desktop } from "@/lib/desktop/client";
import { useMulch } from "@/lib/mulch/client";
import { Recorder } from "@/lib/voice/recorder";
import { useVoice } from "./Mic";
import { useCanvasUi } from "./ui";

/** A tap shorter than this is not a hold (⌥ is also pressed on its way to other shortcuts). */
const MIN_HOLD_MS = 300;

function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
}

/**
 * Hold ⌥ and speak: what is said while holding is one instruction, sent when
 * ⌥ is let go. Thinking out loud (the microphone button) carries on around it
 * and leaves that speech out. Not while typing in a field.
 * Wording is placeholder (George).
 */
export function HoldToTalk({ mulchId }: { mulchId: string }) {
  const [state, setState] = useState<"idle" | "holding" | "sending">("idle");
  const speaking = useVoice((s) => s.speaking);
  const session = useRef<{ recorder: Recorder; chunks: Promise<string>[]; startedAt: number; ready: Promise<void> } | undefined>(undefined);

  useEffect(() => {
    const transcribe = (wav: Blob) =>
      fetch("/api/transcription", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav })
        .then((r) => r.json() as Promise<{ text?: string }>)
        .then((body) => body.text?.trim() ?? "")
        .catch(() => "");
    const start = () => {
      const chunks: Promise<string>[] = [];
      const recorder = new Recorder({ onChunk: (wav) => chunks.push(transcribe(wav)), onLevel: (_level, isSpeaking) => useVoice.setState({ speaking: isSpeaking }) });
      const ready = (async () => {
        const bridge = desktop();
        if (bridge && !(await bridge.microphoneAccess())) throw new Error("Microphone access is off for mlch. Turn it on in System Settings > Privacy & Security > Microphone.");
        await recorder.start();
      })();
      session.current = { recorder, chunks, startedAt: Date.now(), ready };
      useVoice.setState({ holdingSince: Date.now() });
      setState("holding");
      ready.catch((error: Error) => {
        useMulch.setState({ notice: { level: "error", message: error.message, at: Date.now() } });
        stop(true);
      });
    };
    const stop = async (cancel = false) => {
      const current = session.current;
      if (!current) return;
      session.current = undefined;
      await current.ready.catch(() => undefined);
      current.recorder.stop(); // sends what is left
      useVoice.setState({ holdingSince: undefined, heldUntil: Date.now(), speaking: false });
      if (cancel || Date.now() - current.startedAt < MIN_HOLD_MS) return setState("idle");
      setState("sending");
      const instruction = (await Promise.all(current.chunks)).filter(Boolean).join(" ").trim();
      if (instruction) {
        await fetch(`/api/mulches/${mulchId}/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruction, about: useCanvasUi.getState().selectedIds }) });
      }
      setState("idle");
    };
    const onDown = (event: KeyboardEvent) => {
      if (event.key !== "Alt" || event.repeat || event.metaKey || event.ctrlKey || event.shiftKey || typing(event.target) || session.current) return;
      start();
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.key === "Alt") void stop();
    };
    // Another key with ⌥ (a shortcut, a special character) is not a hold.
    const onOther = (event: KeyboardEvent) => {
      if (event.key !== "Alt" && session.current) void stop(true);
    };
    const onBlur = () => void stop(true);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keydown", onOther);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keydown", onOther);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      void stop(true);
    };
  }, [mulchId]);

  if (state === "idle") return null;
  return (
    <div className="mb-2.5 flex justify-center">
      <div className="h-9 pl-3 pr-4 rounded-full bg-amber text-ink text-[13px] font-medium inline-flex items-center gap-2.5 shadow-[var(--float-shadow)]">
        {state === "holding" ? <Scribble which="top" mode="live" active={speaking} duration={2.2} strokeWidth={10} className="h-4 w-10" /> : null}
        {state === "holding" ? "Instruction: let go of ⌥ to send" : "Sending"}
      </div>
    </div>
  );
}
