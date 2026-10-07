"use client";

import { useEffect, useRef, useState } from "react";
import { Mic as MicIcon, Square } from "lucide-react";
import { create } from "zustand";
import { desktop } from "@/lib/desktop/client";
import { useMulch } from "@/lib/mulch/client";
import { Recorder } from "@/lib/voice/recorder";
import { Scribble } from "@/components/brand/Scribble";

interface VoiceState {
  recording: boolean;
  level: number;
  speaking: boolean;
  /** Chunks sent and not yet transcribed. */
  pending: number;
}

export const useVoice = create<VoiceState>(() => ({ recording: false, level: 0, speaking: false, pending: 0 }));

function notify(message: string) {
  useMulch.setState({ notice: { level: "error", message, at: Date.now() } });
}

/** Mic toggle. Chunks are uploaded in order, one at a time. */
export function MicButton({ mulchId }: { mulchId: string }) {
  const recorder = useRef<Recorder | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const recording = useVoice((s) => s.recording);
  const level = useVoice((s) => s.level);
  const [starting, setStarting] = useState(false);

  useEffect(() => () => recorder.current?.stop(), []);

  function upload(wav: Blob, startedAt: number) {
    useVoice.setState((s) => ({ pending: s.pending + 1 }));
    queue.current = queue.current.then(async () => {
      try {
        const response = await fetch(`/api/mulches/${mulchId}/transcribe?at=${startedAt}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          notify(body.error || `Transcription failed (${response.status})`);
        }
      } catch (error) {
        notify((error as Error).message);
      } finally {
        useVoice.setState((s) => ({ pending: Math.max(0, s.pending - 1) }));
      }
    });
  }

  async function start() {
    setStarting(true);
    try {
      const bridge = desktop();
      if (bridge && !(await bridge.microphoneAccess())) {
        notify("Microphone access is off for mlch. Turn it on in System Settings > Privacy & Security > Microphone.");
        return;
      }
      const next = new Recorder({
        onChunk: upload,
        onLevel: (value, speaking) => useVoice.setState({ level: value, speaking }),
      });
      await next.start();
      recorder.current = next;
      useVoice.setState({ recording: true });
    } catch (error) {
      notify(`Microphone: ${(error as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  function stop() {
    recorder.current?.stop();
    recorder.current = undefined;
    useVoice.setState({ recording: false, level: 0, speaking: false });
  }

  return (
    <button
      onClick={recording ? stop : start}
      disabled={starting}
      aria-label={recording ? "Stop microphone" : "Microphone"}
      title={recording ? "Stop" : "Microphone"}
      className={`relative shrink-0 h-10 w-10 grid place-items-center rounded-xl transition-colors ${recording ? "bg-amber text-ink" : "bg-ink text-white hover:bg-ink/85"}`}
    >
      {recording && (
        <span
          className="absolute inset-0 rounded-xl bg-amber/45 pointer-events-none"
          style={{ transform: `scale(${1 + level * 0.5})`, transition: "transform 90ms linear" }}
        />
      )}
      <span className="relative">{recording ? <Square size={13} fill="currentColor" strokeWidth={0} /> : <MicIcon size={18} strokeWidth={1.9} />}</span>
    </button>
  );
}

/** The last few things said, above the input bar, while speaking. */
export function TranscriptStrip() {
  const transcript = useMulch((s) => s.transcript);
  const recording = useVoice((s) => s.recording);
  const speaking = useVoice((s) => s.speaking);
  const pending = useVoice((s) => s.pending);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(timer);
  }, []);
  const recent = transcript.filter((s) => s.source === "speech").slice(-3);
  const lastAt = recent[recent.length - 1]?.at ?? 0;
  if (!recording && !pending && now - lastAt > 20_000) return null;
  return (
    <div className="mb-2.5 px-4 text-[13.5px] leading-snug text-ink-2 space-y-0.5" aria-live="polite">
      {recent.map((segment, i) => (
        <p key={segment.id} style={{ opacity: 0.4 + (i + 1) / (recent.length * 1.7) }}>
          {segment.text}
        </p>
      ))}
      {(recording || pending > 0) && (
        <Scribble
          which="top"
          mode="live"
          active={speaking || pending > 0}
          duration={2.2}
          strokeWidth={9}
          className="h-5 w-auto mt-1.5 text-ink"
          style={{ opacity: speaking || pending > 0 ? 0.85 : 0.35 }}
        />
      )}
    </div>
  );
}
