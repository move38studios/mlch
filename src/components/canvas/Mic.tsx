"use client";

import { useEffect, useState } from "react";
import { Headphones, Mic as MicIcon, Square } from "lucide-react";
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
  /** Listening to a call in this mulch (microphone as "me", the Mac's sound as "them"). */
  call?: { mulchId: string; system: boolean };
  /** Loudness of the Mac's sound during a call, 0–1. */
  systemLevel: number;
}

export const useVoice = create<VoiceState>(() => ({ recording: false, level: 0, speaking: false, pending: 0, systemLevel: 0 }));

function notify(message: string, level: "error" | "info" = "error") {
  useMulch.setState({ notice: { level, message, at: Date.now() } });
}

/* One microphone for the window, whichever control started it. Chunks are uploaded in order, one at a time. */
let recorder: Recorder | undefined;
let queue: Promise<void> = Promise.resolve();

function upload(mulchId: string, wav: Blob, startedAt: number) {
  useVoice.setState((s) => ({ pending: s.pending + 1 }));
  queue = queue.then(async () => {
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

export async function startMic(mulchId: string): Promise<boolean> {
  if (recorder) return true;
  try {
    const bridge = desktop();
    if (bridge && !(await bridge.microphoneAccess())) {
      notify("Microphone access is off for mlch. Turn it on in System Settings > Privacy & Security > Microphone.");
      return false;
    }
    const next = new Recorder({
      onChunk: (wav, at) => upload(mulchId, wav, at),
      onLevel: (value, speaking) => useVoice.setState({ level: value, speaking }),
    });
    await next.start();
    recorder = next;
    useVoice.setState({ recording: true });
    return true;
  } catch (error) {
    notify(`Microphone: ${(error as Error).message}`);
    return false;
  }
}

export function stopMic() {
  recorder?.stop();
  recorder = undefined;
  useVoice.setState({ recording: false, level: 0, speaking: false });
}

let levelTimer: ReturnType<typeof setInterval> | undefined;
let menuListening = false;

/** "Stop Listening" in the menu bar. */
function listenForMenu() {
  if (menuListening) return;
  menuListening = !!desktop()?.onMenu?.((command) => {
    if (command === "stop-call") void stopCall();
  });
}

/** Listen to a call: the microphone and the Mac's sound, captured as conversation. */
export async function startCall(mulchId: string): Promise<void> {
  const current = useVoice.getState().call;
  if (current?.mulchId === mulchId) return;
  if (current) await stopCall();
  listenForMenu();
  const response = await fetch(`/api/mulches/${mulchId}/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start" }) });
  const body = (await response.json().catch(() => ({}))) as { call?: boolean; capture?: unknown; audioError?: string; error?: string };
  if (!response.ok || !body.call) return notify(body.error ?? "The call could not start.");
  useVoice.setState({ call: { mulchId, system: !!body.capture } });
  void desktop()?.setCallState?.({ mulchId });
  if (body.audioError) notify(`Only the microphone: ${body.audioError}`);
  if (!(await startMic(mulchId))) return void stopCall();
  clearInterval(levelTimer);
  levelTimer = setInterval(async () => {
    const state = (await fetch(`/api/mulches/${mulchId}/call`).then((r) => r.json()).catch(() => undefined)) as { call?: boolean; capture?: { peak: number } | null } | undefined;
    if (state && !state.call) return void stopCall(false);
    useVoice.setState({ systemLevel: Math.min(1, (state?.capture?.peak ?? 0) * 3) });
  }, 1000);
}

export async function stopCall(tellServer = true): Promise<void> {
  const call = useVoice.getState().call;
  clearInterval(levelTimer);
  stopMic();
  useVoice.setState({ call: undefined, systemLevel: 0 });
  void desktop()?.setCallState?.(null);
  if (call && tellServer) await fetch(`/api/mulches/${call.mulchId}/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop" }) }).catch(() => {});
}

/** Mic toggle. */
export function MicButton({ mulchId }: { mulchId: string }) {
  const recording = useVoice((s) => s.recording);
  const level = useVoice((s) => s.level);
  const inCall = useVoice((s) => !!s.call);
  const [starting, setStarting] = useState(false);

  useEffect(() => () => void (useVoice.getState().call ? undefined : stopMic()), []);

  async function start() {
    setStarting(true);
    await startMic(mulchId);
    setStarting(false);
  }

  if (inCall) return null;
  return (
    <button
      onClick={recording ? stopMic : () => void start()}
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

/** Call toggle: while on, an amber bar that says so, with both sides' levels; stop at any time. */
export function CallButton({ mulchId }: { mulchId: string }) {
  const call = useVoice((s) => s.call);
  const recording = useVoice((s) => s.recording);
  const level = useVoice((s) => s.level);
  const systemLevel = useVoice((s) => s.systemLevel);
  const [starting, setStarting] = useState(false);
  if (!desktop()) return null;
  if (call?.mulchId === mulchId) {
    return (
      <button onClick={() => void stopCall()} aria-label="Stop listening" title="Stop listening" className="shrink-0 h-10 pl-3 pr-3.5 rounded-xl bg-amber text-ink inline-flex items-center gap-2 text-[13.5px] font-medium">
        <Square size={12} fill="currentColor" strokeWidth={0} />
        Listening
        <span className="flex items-end gap-[3px] h-4" aria-hidden="true">
          <span className="w-[3px] rounded-full bg-ink" style={{ height: `${25 + level * 75}%`, transition: "height 90ms linear" }} />
          {call.system && <span className="w-[3px] rounded-full bg-ink/60" style={{ height: `${25 + systemLevel * 75}%`, transition: "height 300ms linear" }} />}
        </span>
      </button>
    );
  }
  if (recording || call) return null;
  return (
    <button
      onClick={async () => {
        setStarting(true);
        await startCall(mulchId);
        setStarting(false);
      }}
      disabled={starting}
      aria-label="Call"
      title="Listen to a call"
      className="shrink-0 h-10 w-10 grid place-items-center rounded-xl text-ink-2 hover:bg-paper-2 hover:text-ink"
    >
      <Headphones size={18} strokeWidth={1.75} />
    </button>
  );
}

/** The last few things said, above the input bar, while speaking. */
/** While listening: the scribble above the input, drawn as you speak. The words go to the conversation panel. */
export function TranscriptStrip() {
  const recording = useVoice((s) => s.recording);
  const speaking = useVoice((s) => s.speaking);
  const pending = useVoice((s) => s.pending);
  if (!recording && !pending) return null;
  return (
    <div className="mb-2.5 px-4" aria-hidden="true">
      <Scribble
        which="top"
        mode="live"
        active={speaking || pending > 0}
        duration={2.2}
        strokeWidth={9}
        className="h-5 w-auto text-ink"
        style={{ opacity: speaking || pending > 0 ? 0.85 : 0.35 }}
      />
    </div>
  );
}
