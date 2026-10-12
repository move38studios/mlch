"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import type { AgentHarnessStatus } from "@/lib/agent/types";
import { desktop } from "@/lib/desktop/client";
import { Sources } from "@/components/settings/Sources";
import { TranscriptionChoice } from "@/components/settings/TranscriptionSection";

interface Status {
  onboarded: boolean;
  desktop: boolean;
  transcription: "groq" | "local";
  groqKey: boolean;
  local: { installed: boolean; model: string };
  searchModel: "present" | "downloading" | "missing" | "failed";
}

const PRIMARY = "h-8 px-3 rounded-lg bg-ink text-white text-[13px] font-medium disabled:bg-paper-2 disabled:text-ink-3";
const SECONDARY = "h-8 px-2.5 rounded-lg text-[13px] text-ink-2 hover:bg-paper-2 hover:text-ink";

function Row({ title, done, optional, children }: { title: string; done?: boolean; optional?: boolean; children?: React.ReactNode }) {
  return (
    <section className="py-5 border-t border-line first:border-t-0">
      <div className="flex items-center gap-2.5 mb-2">
        <span className={`h-5 w-5 rounded-full grid place-items-center ${done ? "bg-ink text-white" : "border border-line-2"}`}>{done && <Check size={12} strokeWidth={2.5} />}</span>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {optional && <span className="text-[12.5px] text-ink-3">optional</span>}
      </div>
      <div className="pl-[30px]">{children}</div>
    </section>
  );
}

/** First run: one checklist, each item checked live; then a new mulch with the mic ready. */
export function Welcome() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>();
  const [harnesses, setHarnesses] = useState<AgentHarnessStatus[]>();
  const [mic, setMic] = useState<boolean>();
  const [key, setKey] = useState("");

  const load = useCallback(async () => {
    const [onboarding, agents] = await Promise.all([
      fetch("/api/onboarding").then((r) => r.json() as Promise<Status>),
      fetch("/api/agent/status").then((r) => r.json() as Promise<{ harnesses?: AgentHarnessStatus[] }>).catch(() => ({ harnesses: [] })),
    ]);
    setStatus(onboarding);
    setHarnesses(agents.harnesses ?? []);
  }, []);
  useEffect(() => {
    void load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  useEffect(() => {
    if (status?.searchModel !== "downloading") return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [status?.searchModel, load]);

  const ready = harnesses?.find((h) => !h.problem);
  const transcriptionDone = status ? (status.transcription === "local" ? status.local.model === "present" : status.groqKey) : false;
  const settingsPut = (patch: object) => fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then(load);

  async function saveKey() {
    if (!key.trim()) return;
    await desktop()?.credentials.write({ groq: key.trim() });
    setKey("");
    await load();
  }
  async function finish() {
    await fetch("/api/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "done" }) });
    router.replace("/new?mic=1");
  }

  return (
    <main className="h-full overflow-auto bg-paper">
      <div className="drag h-[52px]" />
      <div className="max-w-[620px] mx-auto px-6 pb-16">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/wordmark.svg" alt="mlch" className="h-9 mb-8" />
        {!status || !harnesses ? (
          <Loader2 className="animate-spin text-ink-3" size={18} />
        ) : (
          <>
            <Row title="AI" done={!!ready}>
              {ready ? (
                <p className="text-[14px] text-ink-2">
                  {ready.label}
                  {ready.account?.email ? `, ${ready.account.email}` : ""}
                </p>
              ) : (
                <div className="space-y-2">
                  {harnesses.map((h) => (
                    <div key={h.id} className="flex items-center gap-3 text-[14px]">
                      <span className="w-28">{h.label}</span>
                      <span className="text-ink-3 flex-1">{h.problem}</span>
                      {h.installed && !h.signedIn && (
                        <button onClick={() => void fetch("/api/agent/sign-in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ harness: h.id }) })} className={PRIMARY}>
                          Sign in
                        </button>
                      )}
                    </div>
                  ))}
                  <button onClick={() => void load()} className={SECONDARY}>
                    Check again
                  </button>
                </div>
              )}
            </Row>
            <Row title="Transcription" done={transcriptionDone}>
              <TranscriptionChoice value={status.transcription} onChange={(next) => void settingsPut({ transcription: next })} />
              {status.transcription === "groq" && !status.groqKey && (
                <div className="flex items-center gap-2 mt-3">
                  <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder="Groq API key" aria-label="Groq API key" className="h-9 flex-1 rounded-lg border border-line bg-chrome px-2.5 text-[14px] outline-none focus:border-ink" />
                  <button onClick={() => void saveKey()} disabled={!key.trim()} className={PRIMARY}>
                    Save
                  </button>
                </div>
              )}
            </Row>
            <Row title="Microphone" done={mic}>
              {!mic && (
                <button onClick={async () => setMic(await desktop()?.microphoneAccess())} className={PRIMARY}>
                  Allow
                </button>
              )}
            </Row>
            <Row title="Search" done={status.searchModel === "present"}>
              {status.searchModel === "downloading" ? (
                <span className="inline-flex items-center gap-2 text-[14px] text-ink-3">
                  <Loader2 className="animate-spin" size={14} /> Downloading
                </span>
              ) : (
                status.searchModel !== "present" && (
                  <button onClick={() => void fetch("/api/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "download-search" }) }).then(load)} className={PRIMARY}>
                    {status.searchModel === "failed" ? "Try again" : "Download"}
                  </button>
                )
              )}
            </Row>
            <Row title="Folders" optional>
              <Sources />
            </Row>
            <div className="pt-6">
              <button onClick={() => void finish()} disabled={!ready || !transcriptionDone} className="h-10 px-5 rounded-xl bg-amber text-ink text-[14.5px] font-semibold disabled:bg-paper-2 disabled:text-ink-3">
                Start
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
