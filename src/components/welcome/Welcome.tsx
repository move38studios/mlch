"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Loader2, X } from "lucide-react";
import type { AgentHarnessStatus } from "@/lib/agent/types";
import { desktop } from "@/lib/desktop/client";
import { Recorder } from "@/lib/voice/recorder";
import { SharingChoice, useSharing } from "@/components/settings/Sharing";
import { Sources } from "@/components/settings/Sources";
import { AiAccess, type AuthMode } from "@/components/settings/AiAccess";
import { KeyField } from "@/components/settings/KeyField";
import { Scribble } from "@/components/brand/Scribble";

type KeyName = "groq" | "exa" | "fal" | "firecrawl" | "gemini" | "anthropic" | "openai";
type HarnessId = "claude" | "codex";
interface Status {
  onboarded: boolean;
  desktop: boolean;
  harness: HarnessId;
  agentAuth: Record<HarnessId, AuthMode>;
  consent: Record<HarnessId, boolean>;
  transcription: "groq" | "local";
  keys: Record<KeyName, boolean>;
  local: { installed: boolean; model: string; progress?: number };
  searchModel: "present" | "downloading" | "missing" | "failed";
  vaults: Array<{ path: string; name: string }>;
}

/*
 * All text here is placeholder (George's wording replaces it), except the
 * welcome line and "Your context", which are his.
 */
const STEPS = ["welcome", "about", "ai", "access", "speech", "permissions", "web", "context", "calls", "sharing", "ready"] as const;
type Step = (typeof STEPS)[number];

const AI: Record<HarnessId, { name: string; app: string; plan: string }> = {
  claude: { name: "Claude", app: "Claude Code", plan: "Claude" },
  codex: { name: "ChatGPT", app: "Codex", plan: "ChatGPT" },
};
const KEYS: Array<{ id: "exa" | "firecrawl" | "fal" | "gemini"; label: string; use: string; url: string }> = [
  { id: "exa", label: "Exa", use: "Web search, for enrichment and research.", url: "https://dashboard.exa.ai/api-keys" },
  { id: "firecrawl", label: "Firecrawl", use: "Reads web pages and documents in full.", url: "https://www.firecrawl.dev/app/api-keys" },
  { id: "fal", label: "fal", use: "Makes images, video, voice and music.", url: "https://fal.ai/dashboard/keys" },
  { id: "gemini", label: "Gemini", use: "Watches YouTube videos you add, for a summary and a transcript.", url: "https://aistudio.google.com/apikey" },
];

const PRIMARY = "h-10 px-5 rounded-xl bg-ink text-white text-[14px] font-medium disabled:bg-paper-2 disabled:text-ink-3 transition-colors";
const SMALL_PRIMARY = "h-8 px-3 rounded-lg bg-ink text-white text-[13px] font-medium disabled:bg-paper-2 disabled:text-ink-3";
const SECONDARY = "h-8 px-2.5 rounded-lg text-[13px] text-ink-2 hover:bg-paper-2 hover:text-ink inline-flex items-center shrink-0";
const post = (url: string, body: object) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/* ── pieces ─────────────────────────────────────────────────────── */

function Heading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-7">
      <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.01em]">{title}</h1>
      {children && <div className="mt-2.5 text-[15px] leading-relaxed text-ink-2 space-y-2">{children}</div>}
    </div>
  );
}

/** A choice shown as a card; the chosen one carries the ink outline and a check. */
function Choice({ selected, disabled, onSelect, title, meta, children }: { selected: boolean; disabled?: boolean; onSelect: () => void; title: string; meta?: string; children?: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`w-full text-left rounded-2xl bg-chrome px-5 py-4 flex items-start gap-4 transition-[border-color,box-shadow] disabled:opacity-45 ${
        selected ? "border-[1.5px] border-ink shadow-[var(--float-shadow)]" : "border border-line hover:border-line-2"
      }`}
    >
      <span className={`mt-0.5 h-5 w-5 shrink-0 rounded-full grid place-items-center ${selected ? "bg-ink text-white" : "border border-line-2"}`}>{selected && <Check size={12} strokeWidth={2.75} />}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-[15.5px] font-semibold">{title}</span>
          {meta && <span className="text-[13px] text-ink-3">{meta}</span>}
        </span>
        {children && <span className="block mt-1 text-[13.5px] leading-relaxed text-ink-2">{children}</span>}
      </span>
    </button>
  );
}

function Bar({ fraction }: { fraction?: number }) {
  return (
    <span className="block h-1.5 w-full rounded-full bg-paper-2 overflow-hidden">
      <span className={`block h-full rounded-full bg-ink transition-[width] duration-500 ${fraction === undefined ? "w-1/3 animate-pulse" : ""}`} style={fraction === undefined ? undefined : { width: `${Math.max(3, Math.round(fraction * 100))}%` }} />
    </span>
  );
}

function Done({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13.5px] text-ink">
      <span className="h-[18px] w-[18px] rounded-full bg-ink text-white grid place-items-center">
        <Check size={11} strokeWidth={3} />
      </span>
      {children}
    </span>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-line bg-chrome px-5 py-4">{children}</div>;
}

/* ── the microphone test ────────────────────────────────────────── */

function MicTest({ ready, progress }: { ready: boolean; progress?: number }) {
  const [state, setState] = useState<"idle" | "listening" | "denied" | "allowed">("idle");
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const [words, setWords] = useState<string[]>([]);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string>();
  const recorder = useRef<Recorder | undefined>(undefined);
  useEffect(() => () => recorder.current?.stop(), []);

  async function allow(): Promise<boolean> {
    const bridge = desktop();
    if (bridge && !(await bridge.microphoneAccess())) {
      setState("denied");
      return false;
    }
    return true;
  }
  async function start() {
    setError(undefined);
    if (!(await allow())) return;
    if (!ready) return setState("allowed");
    const next = new Recorder({
      onLevel: (value, isSpeaking) => {
        setLevel(value);
        setSpeaking(isSpeaking);
      },
      onChunk: (wav) => {
        setPending((n) => n + 1);
        void fetch("/api/transcription", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav })
          .then(async (response) => {
            const body = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
            if (!response.ok) setError(body.error ?? "Transcription failed.");
            else if (body.text) setWords((w) => [...w, body.text!]);
          })
          .finally(() => setPending((n) => n - 1));
      },
    });
    try {
      await next.start();
      recorder.current = next;
      setState("listening");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function stop() {
    recorder.current?.stop();
    recorder.current = undefined;
    setState("idle");
    setLevel(0);
    setSpeaking(false);
  }

  return (
    <Card>
      <div className="flex items-center gap-3">
        <span className="text-[15px] font-semibold flex-1">Microphone</span>
        {state === "listening" ? (
          <button onClick={stop} className={SMALL_PRIMARY}>
            Stop
          </button>
        ) : state === "denied" ? (
          <span className="text-[13px] text-danger">Off in System Settings</span>
        ) : state === "allowed" ? (
          <Done>Allowed</Done>
        ) : (
          <button onClick={() => void start()} className="h-8 px-3.5 rounded-lg bg-amber text-ink text-[13px] font-semibold">
            {ready ? (words.length ? "Try again" : "Try it") : "Allow"}
          </button>
        )}
      </div>
      <p className="mt-1 text-[13.5px] text-ink-2">
        {state === "denied"
          ? "Turn mlch on in System Settings > Privacy & Security > Microphone."
          : ready
            ? "Say a sentence. The words appear here."
            : `The speech model is downloading${progress !== undefined ? ` (${Math.round(progress * 100)}%)` : ""}. The test works once it is done.`}
      </p>
      {(state === "listening" || words.length > 0 || pending > 0) && (
        <div className="mt-4 rounded-xl bg-paper px-4 py-3 min-h-[64px] flex items-start gap-3">
          {state === "listening" && (
            <span className="shrink-0 w-12 h-8 grid place-items-center" style={{ transform: `scale(${0.85 + level * 0.4})` }}>
              <Scribble mode="live" active={speaking} strokeWidth={9} className="w-12 h-8" />
            </span>
          )}
          <p data-heard className="text-[15px] leading-relaxed flex-1">
            {words.join(" ")}
            {pending > 0 && <Loader2 className="inline animate-spin text-ink-3 ml-1.5 -mt-0.5" size={13} />}
            {!words.length && !pending && <span className="text-ink-3">Listening</span>}
          </p>
        </div>
      )}
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
    </Card>
  );
}

function SystemAudio({ available }: { available: boolean }) {
  const [state, setState] = useState<"idle" | "asking" | "done" | "failed">("idle");
  const [error, setError] = useState<string>();
  async function ask() {
    setState("asking");
    const response = await post("/api/onboarding", { action: "system-audio" });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.ok) setState("done");
    else {
      setError(body.error);
      setState("failed");
    }
  }
  return (
    <Card>
      <div className="flex items-center gap-3">
        <span className="text-[15px] font-semibold flex-1">Call audio</span>
        {/* macOS has no public way to read this permission; the helper asks TCC and refuses when it is denied, so a denial shows as the error. */}
        {state !== "done" && (
          <button onClick={() => void ask()} disabled={!available || state === "asking"} className="h-8 px-3.5 rounded-lg bg-amber text-ink text-[13px] font-semibold disabled:bg-paper-2 disabled:text-ink-3">
            {state === "asking" ? "Asking" : "Allow"}
          </button>
        )}
      </div>
      <p className="mt-1 text-[13.5px] text-ink-2">
        {!available
          ? "Not available on this Mac."
          : "To hear the other people on a call, mlch records your Mac's sound during calls. macOS asks you to allow this."}
      </p>
      {available && state === "done" && (
        <p className="mt-1 text-[13.5px] text-ink-2">If it is off: System Settings &gt; Privacy &amp; Security &gt; Screen &amp; System Audio Recording.</p>
      )}
      {state === "failed" && <p className="mt-2 text-[13px] text-danger">{error ?? "Could not ask."}</p>}
    </Card>
  );
}

/* ── the steps ──────────────────────────────────────────────────── */

/**
 * First run, one step at a time: the AI and how it is paid for, speech,
 * permissions, optional keys and folders, the menu bar. Models download from
 * the first step on. Done goes to the list, where "Start here" waits.
 */
export function Welcome() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>();
  const [harnesses, setHarnesses] = useState<AgentHarnessStatus[]>();
  const [step, setStep] = useState<Step>();
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const sharing = useSharing((s) => s.view);

  const load = useCallback(async () => {
    const [onboarding, agents] = await Promise.all([
      fetch("/api/onboarding").then((r) => r.json() as Promise<Status>),
      fetch("/api/agent/status").then((r) => r.json() as Promise<{ harnesses?: AgentHarnessStatus[] }>).catch(() => ({ harnesses: [] })),
    ]);
    setStatus(onboarding);
    setHarnesses(agents.harnesses ?? []);
    // Back from Settings: skip the welcome.
    setStep((current) => current ?? (onboarding.onboarded ? "ai" : "welcome"));
  }, []);
  useEffect(() => {
    // The search model is always needed: it starts at once.
    void post("/api/onboarding", { action: "downloads" }).then(load);
    void desktop()?.openAtLogin?.().then(setOpenAtLogin);
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const harness = harnesses?.find((h) => h.id === status?.harness);
  const busy =
    status?.searchModel === "downloading" ||
    status?.local.model === "downloading" ||
    !!harnesses?.some((h) => h.cli?.state === "downloading" || h.cli?.state === "checking" || (h.cli?.state === "ready" && !h.installed) || h.signIn.state === "pending");
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [busy, load]);
  // Leaving the speech step with "On this Mac" starts its download.
  useEffect(() => {
    if (status?.transcription === "local" && status.local.model === "missing" && step && STEPS.indexOf(step) >= STEPS.indexOf("speech")) void post("/api/onboarding", { action: "speech" }).then(load);
  }, [status?.transcription, status?.local.model, step, load]);

  const put = (patch: object) => fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then(load);
  const usable = (h: AgentHarnessStatus) => !h.problem && (status?.agentAuth[h.id] === "apiKey" || !!status?.consent[h.id]);
  async function access(id: HarnessId, change: { agentAuth?: AuthMode; consent?: boolean } | { keySaved: true }) {
    if (!status) return;
    if ("keySaved" in change) return load();
    if (change.agentAuth) await put({ agentAuth: { ...status.agentAuth, [id]: change.agentAuth } });
    if (change.consent !== undefined) {
      const settings = (await (await fetch("/api/settings")).json()) as { settings: { subscriptionConsent: Record<string, number | undefined> } };
      await put({ subscriptionConsent: { ...settings.settings.subscriptionConsent, [id]: change.consent ? Date.now() : undefined } });
    }
  }
  async function finish() {
    await post("/api/onboarding", { action: "done" });
    router.replace("/");
  }

  if (!status || !harnesses || !step) {
    return (
      <main className="h-full grid place-items-center bg-paper">
        <Loader2 className="animate-spin text-ink-3" size={18} />
      </main>
    );
  }

  const index = STEPS.indexOf(step);
  const go = (offset: number) => setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, index + offset))]);
  const speechReady = status.local.model === "present";
  const speechDone = status.transcription === "local" ? status.local.installed : status.keys.groq;
  // mlch.app sharing is chosen only with a subscription; No sharing and an own server go on.
  const sharingDone = !sharing || sharing.mode !== "mlch" || !!sharing.account?.canShare;
  const canContinue = step === "ai" ? !!harness : step === "access" ? !!harness && usable(harness) : step === "speech" ? speechDone : step === "sharing" ? sharingDone : true;
  const optional = step === "web" && !KEYS.some((k) => status.keys[k.id]);

  /* What is downloading, for the footer. */
  const downloads: Array<{ label: string; fraction?: number }> = [];
  if (status.local.model === "downloading") downloads.push({ label: "speech model", fraction: status.local.progress });
  if (status.searchModel === "downloading") downloads.push({ label: "search model" });
  for (const h of harnesses) if (h.cli?.state === "downloading") downloads.push({ label: AI[h.id as HarnessId]?.app ?? h.label, fraction: h.cli.progress });

  let body: React.ReactNode;
  switch (step) {
    case "welcome":
      body = (
        <div className="flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/icon.svg" alt="" className="h-24 w-24 drop-shadow-[0_10px_22px_rgba(0,0,0,0.16)] -rotate-3" />
          <h1 className="mt-10 text-[34px] leading-tight font-semibold tracking-[-0.015em]">Welcome to mlch</h1>
          <p className="mt-3 text-[18px] text-ink-2">An AI app for non-linear thinkers.</p>
          <button onClick={() => go(1)} className="mt-12 h-12 px-8 rounded-2xl bg-amber text-ink text-[16px] font-semibold shadow-[var(--float-shadow)] hover:brightness-[1.03]">
            Get started
          </button>
        </div>
      );
      break;

    case "about":
      body = (
        <>
          <Heading title="A whiteboard that thinks with you">
            <p>A partner to think with, and a live canvas for every project, call and idea. While you talk, it maps, researches and connects what you say to everything you&rsquo;ve explored before. Then it makes the deck.</p>
          </Heading>
          <ul className="space-y-3.5">
            {[
              "You talk or type; mlch maps it onto the canvas while you speak.",
              "It looks things up as you go: sources, examples, definitions, the questions worth asking.",
              "It spots where today\u2019s thinking meets what you explored before, in other canvases and in your notes, and draws the line.",
              "Ask for a deck, a document or an interactive page, and share it with a link.",
              "On calls it listens to both sides and keeps the notes.",
            ].map((line) => (
              <li key={line} className="flex gap-3.5 text-[15px] leading-relaxed">
                <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink" />
                {line}
              </li>
            ))}
          </ul>
        </>
      );
      break;

    case "ai":
      body = (
        <>
          <Heading title="Your AI">
            <p>mlch thinks with you using Claude or ChatGPT, through Claude Code or Codex on this Mac. Pick the one you use. You can switch later in Settings.</p>
          </Heading>
          <div className="space-y-3">
            {harnesses.map((h) => {
              const id = h.id as HarnessId;
              // While mlch looks for the program (asking it for its version can take a few seconds), and until
              // the AI's own status (cached for a few seconds) catches up with what it found, it says so.
              const checking = !h.installed && (h.cli?.state === "checking" || h.cli?.state === "ready");
              const line = checking
                ? `Looking for ${AI[id].app} on this Mac`
                : h.signedIn && h.account?.email
                  ? `Signed in as ${h.account.email}`
                  : h.installed
                    ? `${AI[id].app} is on this Mac`
                    : h.cli?.state === "downloading"
                      ? `Downloading ${AI[id].app}`
                      : `${AI[id].app} is not on this Mac yet. mlch can download it.`;
              return (
                <Choice key={id} selected={status.harness === id} onSelect={() => void put({ harness: id })} title={AI[id].name} meta={AI[id].app}>
                  {checking && <Loader2 className="inline animate-spin mr-1.5 -mt-0.5 text-ink-3" size={12} />}
                  {line}
                </Choice>
              );
            })}
          </div>
        </>
      );
      break;

    case "access": {
      const h = harness!;
      const id = h.id as HarnessId;
      const names = AI[id];
      const cli = h.cli;
      const mode = status.agentAuth[id];
      body = (
        <>
          <Heading title={`Connect ${names.name}`}>
            <p>
              mlch runs {names.app} here, on your Mac. Use your {names.plan} subscription, or an API key.
            </p>
          </Heading>
          <div className="space-y-3">
            {(cli?.state === "missing" || cli?.state === "downloading" || cli?.state === "failed") && (
              <Card>
                <div className="flex items-center gap-3">
                  <span className="text-[15px] font-semibold flex-1">{names.app}</span>
                  {cli.state === "missing" && (
                    <button onClick={() => void post("/api/agent/status", { id }).then(load)} className={SMALL_PRIMARY}>
                      Download
                    </button>
                  )}
                  {cli.state === "failed" && (
                    <button onClick={() => void post("/api/agent/status", { id }).then(load)} className={SMALL_PRIMARY}>
                      Try again
                    </button>
                  )}
                </div>
                {cli.state === "downloading" ? (
                  <div className="mt-3 flex items-center gap-3">
                    <Bar fraction={cli.progress} />
                    <span className="text-[12.5px] text-ink-3 tabular-nums w-10 text-right">{cli.progress !== undefined ? `${Math.round(cli.progress * 100)}%` : ""}</span>
                  </div>
                ) : (
                  <p className="mt-1 text-[13.5px] text-ink-2">{cli.state === "failed" ? cli.error : `Not on this Mac. mlch downloads the version it was tested with, from ${id === "claude" ? "Anthropic" : "OpenAI"}.`}</p>
                )}
              </Card>
            )}
            <Card>
              <AiAccess id={id} mode={mode} consented={status.consent[id]} onChange={(change) => void access(id, change)} />
              {mode === "subscription" && h.installed && (
                <div className="mt-3 pt-3 border-t border-line flex items-center gap-3">
                  {h.signedIn ? (
                    <Done>Signed in{h.account?.email ? ` as ${h.account.email}` : ""}</Done>
                  ) : h.signIn.state === "pending" ? (
                    <span className="text-[13.5px] text-ink-2 inline-flex items-center gap-2">
                      <Loader2 className="animate-spin" size={13} />
                      Finish signing in in your browser.
                      {h.signIn.userCode && <span className="font-mono text-ink">{h.signIn.userCode}</span>}
                      {h.signIn.url && (
                        <a href={h.signIn.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                          Open
                        </a>
                      )}
                    </span>
                  ) : (
                    <>
                      <span className="text-[13.5px] text-ink-2 flex-1">{h.signIn.state === "failed" ? (h.signIn.error ?? "Sign-in failed.") : `Not signed in to ${names.app}.`}</span>
                      <button onClick={() => void post("/api/agent/sign-in", { harness: id }).then(load)} className={SMALL_PRIMARY}>
                        Sign in
                      </button>
                    </>
                  )}
                </div>
              )}
              {mode === "apiKey" && <p className="mt-3 text-[13px] text-ink-3">Use is billed to the API account the key belongs to.</p>}
            </Card>
          </div>
        </>
      );
      break;
    }

    case "speech":
      body = (
        <>
          <Heading title="Speech">
            <p>mlch turns what you say into text. Choose where that happens.</p>
          </Heading>
          <div className="space-y-3">
            <Choice selected={status.transcription === "local"} disabled={!status.local.installed} onSelect={() => void put({ transcription: "local" })} title="On this Mac" meta={status.local.installed ? "600 MB download" : "Not available on this Mac"}>
              Private: audio never leaves your Mac. Works offline.
            </Choice>
            <Choice selected={status.transcription === "groq"} onSelect={() => void put({ transcription: "groq" })} title="Groq" meta="Needs a key">
              Audio is sent to Groq to be transcribed. Nothing to download.
            </Choice>
            {status.transcription === "groq" && (
              <div className="pt-1">
                <KeyField name="groq" label="Groq" url="https://console.groq.com/keys" onChanged={() => void load()} />
              </div>
            )}
          </div>
        </>
      );
      break;

    case "permissions":
      body = (
        <>
          <Heading title="Microphone and calls">
            <p>macOS asks you to allow these once.</p>
          </Heading>
          <div className="space-y-3">
            <MicTest ready={status.transcription === "groq" ? status.keys.groq : speechReady} progress={status.local.progress} />
            <SystemAudio available={status.local.installed} />
          </div>
        </>
      );
      break;

    case "web":
      body = (
        <>
          <Heading title="Web and making">
            <p>Optional. These services make mlch better at finding things and making things. Each needs its own key; you can add them later in Settings.</p>
          </Heading>
          <div className="space-y-3">
            {KEYS.map((key) => (
              <Card key={key.id}>
                <div className="text-[15px] font-semibold">{key.label}</div>
                <p className="mt-0.5 mb-3 text-[13.5px] text-ink-2">{key.use}</p>
                <KeyField name={key.id} label={key.label} url={key.url} onChanged={() => void load()} />
              </Card>
            ))}
          </div>
        </>
      );
      break;

    case "context":
      body = (
        <>
          <Heading title="Your context">
            <p>Add the folders that hold what you know: an Obsidian vault, notes, documents about your work. Every canvas can draw on them, and mlch links what you think about now to what&rsquo;s already there.</p>
            <p>Good to add: notes, writing, research, company documents. Not worth adding: your whole home folder, Documents or Downloads, code projects, photo or music libraries.</p>
            <p className="text-[13.5px] text-ink-3">mlch reads Markdown, text, PDF, Word, RTF and HTML. It skips images, audio, video, spreadsheets and slides. Up to 20,000 files per folder. It never changes your files unless you let it add notes, and it keeps up as they change.</p>
          </Heading>
          <div className="space-y-3">
            {status.vaults.map((vault) => (
              <Card key={vault.path}>
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold truncate">{vault.name}</span>
                    <span className="block text-[13px] text-ink-3">Obsidian vault on this Mac</span>
                  </span>
                  <button onClick={() => void post("/api/sources", { path: vault.path }).then(load)} className={SMALL_PRIMARY}>
                    Add
                  </button>
                </div>
              </Card>
            ))}
            <Sources key={status.vaults.length} />
          </div>
        </>
      );
      break;

    case "calls":
      body = (
        <>
          <Heading title="Calls">
            <p>Start a call from the menu bar, or press ⌃⌘L in any app. mlch listens to you and the people on the call. Ideas, decisions and to-dos appear on the canvas as you talk. You keep the full transcript, and notes when the call ends.</p>
          </Heading>
          <div className="rounded-2xl border border-line bg-chrome overflow-hidden">
            <div className="h-8 bg-paper-2 flex items-center justify-end gap-4 px-4 text-[12.5px] text-ink-2">
              <span className="h-2 w-8 rounded-full bg-ink/10" />
              <span className="h-6 w-6 rounded-md bg-ink/10 grid place-items-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/menubar.svg" alt="mlch in the menu bar" className="h-[18px] w-[18px]" />
              </span>
              <span className="h-2 w-10 rounded-full bg-ink/10" />
            </div>
            <div className="flex justify-end pr-[58px] pb-5">
              <div className="mt-1 w-56 rounded-xl border border-line bg-chrome shadow-[var(--float-shadow)] py-1.5 text-[13px]">
                <div className="px-3 py-1">New</div>
                <div className="px-3 py-1 flex justify-between bg-amber/90 rounded-md mx-1.5">
                  <span className="font-medium">New Call</span>
                  <span>⌃⌘L</span>
                </div>
                <div className="my-1 border-t border-line" />
                <div className="px-3 py-1 text-ink-3">Recent</div>
              </div>
            </div>
          </div>
          <label className="mt-5 flex items-center gap-2.5 text-[14px]">
            <input type="checkbox" checked={openAtLogin} onChange={(e) => void desktop()?.openAtLogin?.(e.target.checked).then(setOpenAtLogin)} className="h-4 w-4" />
            Open mlch at login
          </label>
        </>
      );
      break;

    case "sharing":
      body = (
        <>
          <Heading title="Sharing">
            <p>Share a canvas or something mlch made as a link. A shared canvas stays live: people with the link watch it change as you work.</p>
          </Heading>
          <SharingChoice />
        </>
      );
      break;

    case "ready":
      body = (
        <div className="flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/icon.svg" alt="" className="h-20 w-20 drop-shadow-[0_10px_22px_rgba(0,0,0,0.16)] rotate-2" />
          <h1 className="mt-6 text-[30px] leading-tight font-semibold tracking-[-0.01em]">Ready</h1>
          <p className="mt-3 text-[15px] text-ink-2 max-w-[400px]">&ldquo;Start here&rdquo; in your list shows how mlch works.</p>
          {downloads.length > 0 && <p className="mt-2 text-[13.5px] text-ink-3 max-w-[400px]">Downloads continue in the background.</p>}
          <button onClick={() => void finish()} className="mt-10 h-12 px-8 rounded-2xl bg-amber text-ink text-[16px] font-semibold shadow-[var(--float-shadow)] hover:brightness-[1.03]">
            Open mlch
          </button>
        </div>
      );
      break;
  }

  const framed = step !== "welcome" && step !== "ready";
  return (
    <main className="h-full flex flex-col bg-paper">
      <header className="drag relative h-[52px] shrink-0 flex items-center justify-center">
        {/* Opened again from Settings: every step is saved as it goes, so it can be left at any point. */}
        {status.onboarded && (
          <button onClick={() => router.push("/settings")} className={`no-drag absolute right-3 ${SECONDARY} gap-1.5`}>
            <X size={14} /> Close
          </button>
        )}
        {step !== "welcome" && (
          <div className="flex items-center gap-1.5" aria-label={`Step ${index} of ${STEPS.length - 1}`}>
            {STEPS.slice(1).map((s, i) => (
              <span key={s} className={`h-1.5 rounded-full transition-all duration-300 ${i + 1 === index ? "w-5 bg-ink" : i + 1 < index ? "w-1.5 bg-ink" : "w-1.5 bg-line-2"}`} />
            ))}
          </div>
        )}
      </header>
      <div className="flex-1 overflow-auto">
        <div className="min-h-full flex items-center justify-center px-6 py-8">
          <div key={step} className="step-enter w-full max-w-[540px]">
            {body}
          </div>
        </div>
      </div>
      {step !== "welcome" && (
        <footer className="shrink-0 h-[68px] border-t border-line flex items-center gap-4 px-6">
          <button onClick={() => go(-1)} className={`${SECONDARY} gap-1.5`}>
            <ArrowLeft size={14} /> Back
          </button>
          <div className="flex-1 min-w-0 flex justify-center">
            {downloads[0] && (
              <div className="w-64 max-w-full">
                <div className="flex justify-between text-[12px] text-ink-3 mb-1">
                  <span className="truncate">
                    Downloading {downloads[0].label}
                    {downloads.length > 1 ? ` and ${downloads.length - 1} more` : ""}
                  </span>
                  {downloads[0].fraction !== undefined && <span className="tabular-nums">{Math.round(downloads[0].fraction * 100)}%</span>}
                </div>
                <Bar fraction={downloads[0].fraction} />
              </div>
            )}
          </div>
          {framed && (
            <button onClick={() => go(1)} disabled={!canContinue} className={PRIMARY}>
              {optional ? "Skip" : "Continue"}
            </button>
          )}
          {!framed && <span className="w-[100px]" />}
        </footer>
      )}
    </main>
  );
}
