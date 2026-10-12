"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import type { AgentHarnessStatus } from "@/lib/agent/types";
import { desktop } from "@/lib/desktop/client";
import { Sources } from "@/components/settings/Sources";

type KeyName = "groq" | "exa" | "fal" | "firecrawl";
interface Status {
  onboarded: boolean;
  desktop: boolean;
  harness: "claude" | "codex";
  transcription: "groq" | "local";
  keys: Record<KeyName, boolean>;
  local: { installed: boolean; model: string; progress?: number };
  searchModel: "present" | "downloading" | "missing" | "failed";
  vaults: Array<{ path: string; name: string }>;
}

/** Where each key comes from. Labels and lines are placeholders for George's wording. */
const KEYS: Array<{ id: Exclude<KeyName, "groq">; label: string; use: string; url: string }> = [
  { id: "exa", label: "Exa", use: "Web search for enrichment and research", url: "https://dashboard.exa.ai/api-keys" },
  { id: "fal", label: "fal", use: "Images, video, voice and music", url: "https://fal.ai/dashboard/keys" },
  { id: "firecrawl", label: "Firecrawl", use: "Reading web pages and documents", url: "https://www.firecrawl.dev/app/api-keys" },
];
const HARNESS_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

const PRIMARY = "h-8 px-3 rounded-lg bg-ink text-white text-[13px] font-medium disabled:bg-paper-2 disabled:text-ink-3";
const SECONDARY = "h-8 px-2.5 rounded-lg text-[13px] text-ink-2 hover:bg-paper-2 hover:text-ink";
const CHIP = "h-8 px-3 rounded-full text-[13px] inline-flex items-center gap-1.5";
const ON = "border-[1.5px] border-ink text-ink font-medium";
const OFF = "border border-line text-ink-3 hover:border-line-2 hover:text-ink";
const FIELD = "h-8 flex-1 min-w-0 rounded-lg border border-line bg-chrome px-2.5 text-[13.5px] outline-none focus:border-ink";

function Row({ title, done, optional, children }: { title: string; done?: boolean; optional?: boolean; children?: React.ReactNode }) {
  return (
    <section className="py-5 border-t border-line first:border-t-0">
      <div className="flex items-center gap-2.5 mb-2.5">
        <span className={`h-5 w-5 rounded-full grid place-items-center ${done ? "bg-ink text-white" : "border border-line-2"}`}>{done && <Check size={12} strokeWidth={2.5} />}</span>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {optional && <span className="text-[12.5px] text-ink-3">optional</span>}
      </div>
      <div className="pl-[30px] space-y-2.5">{children}</div>
    </section>
  );
}

/** A key field with where to get one. */
function KeyField({ id, label, use, url, saved, onSaved }: { id: KeyName; label: string; use?: string; url: string; saved: boolean; onSaved: () => void }) {
  const [value, setValue] = useState("");
  async function save() {
    if (!value.trim()) return;
    await desktop()?.credentials.write({ [id]: value.trim() });
    setValue("");
    onSaved();
  }
  return (
    <div>
      <div className="flex items-baseline gap-2 text-[14px]">
        <span className="font-medium w-24 shrink-0">{label}</span>
        {use && <span className="text-ink-3 text-[13px]">{use}</span>}
      </div>
      <div className="flex items-center gap-2 mt-1.5 pl-[104px]">
        {saved ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
            <Check size={13} strokeWidth={2.25} /> Saved
          </span>
        ) : (
          <>
            <input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} type="password" placeholder={`${label} API key`} aria-label={`${label} API key`} className={FIELD} />
            <button onClick={() => void save()} disabled={!value.trim()} className={PRIMARY}>
              Save
            </button>
            <a href={url} target="_blank" rel="noreferrer" className={`${SECONDARY} inline-flex items-center shrink-0`}>
              Get a key
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function Progress({ label, state, fraction }: { label: string; state: string; fraction?: number }) {
  return (
    <div className="flex items-center gap-2 text-[14px]">
      <span className="w-28 text-ink-2">{label}</span>
      {state === "present" ? (
        <Check size={14} strokeWidth={2.25} />
      ) : state === "downloading" ? (
        <span className="inline-flex items-center gap-2 text-ink-3">
          <Loader2 className="animate-spin" size={13} /> {fraction !== undefined ? `${Math.round(fraction * 100)}%` : "Downloading"}
        </span>
      ) : (
        <span className="text-ink-3">{state === "failed" ? "Failed" : state === "unavailable" ? "Not available on this Mac" : "Waiting"}</span>
      )}
    </div>
  );
}

/**
 * First run: sign in, pick defaults, keys (skippable), folders. Models
 * download meanwhile; permissions are asked when first needed. Start goes to
 * the list, where "Start here" waits.
 */
export function Welcome() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>();
  const [harnesses, setHarnesses] = useState<AgentHarnessStatus[]>();

  const load = useCallback(async () => {
    const [onboarding, agents] = await Promise.all([
      fetch("/api/onboarding").then((r) => r.json() as Promise<Status>),
      fetch("/api/agent/status").then((r) => r.json() as Promise<{ harnesses?: AgentHarnessStatus[] }>).catch(() => ({ harnesses: [] })),
    ]);
    setStatus(onboarding);
    setHarnesses(agents.harnesses ?? []);
  }, []);
  useEffect(() => {
    // Downloads start at once; nothing to decide.
    void fetch("/api/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "downloads" }) }).then(load);
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  const downloading = status?.searchModel === "downloading" || status?.local.model === "downloading";
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [downloading, load]);

  const put = (patch: object) => fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then(load);
  const ready = harnesses?.filter((h) => !h.problem) ?? [];
  const aiDone = ready.some((h) => h.id === status?.harness);
  const transcriptionDone = status ? (status.transcription === "local" ? status.local.model === "present" || status.local.model === "downloading" : status.keys.groq) : false;

  async function linkVault(vaultPath: string) {
    await fetch("/api/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: vaultPath }) });
    await load();
  }
  async function finish() {
    await fetch("/api/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "done" }) });
    router.replace("/");
  }

  return (
    <main className="h-full overflow-auto bg-paper">
      <div className="drag h-[52px]" />
      <div className="max-w-[640px] mx-auto px-6 pb-16">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/wordmark.svg" alt="mlch" className="h-9 mb-8" />
        {!status || !harnesses ? (
          <Loader2 className="animate-spin text-ink-3" size={18} />
        ) : (
          <>
            <Row title="AI" done={aiDone}>
              {ready.length > 1 && (
                <div className="flex gap-2">
                  {ready.map((h) => (
                    <button key={h.id} aria-pressed={status.harness === h.id} onClick={() => void put({ harness: h.id })} className={`${CHIP} ${status.harness === h.id ? ON : OFF}`}>
                      {status.harness === h.id && <Check size={13} strokeWidth={2.25} />}
                      {HARNESS_NAMES[h.id] ?? h.label}
                    </button>
                  ))}
                </div>
              )}
              {harnesses.map((h) => (
                <div key={h.id} className="flex items-center gap-3 text-[14px]">
                  <span className="w-20 font-medium">{HARNESS_NAMES[h.id] ?? h.label}</span>
                  <span className="text-ink-3 flex-1 truncate">{h.problem ?? h.account?.email ?? ""}</span>
                  {h.installed && !h.signedIn && (
                    <button onClick={() => void fetch("/api/agent/sign-in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ harness: h.id }) })} className={PRIMARY}>
                      Sign in
                    </button>
                  )}
                  {ready.length === 1 && !h.problem && status.harness !== h.id && (
                    <button onClick={() => void put({ harness: h.id })} className={SECONDARY}>
                      Use
                    </button>
                  )}
                </div>
              ))}
              {!ready.length && (
                <button onClick={() => void load()} className={SECONDARY}>
                  Check again
                </button>
              )}
            </Row>

            <Row title="Transcription" done={transcriptionDone}>
              <div className="flex gap-2">
                {(["local", "groq"] as const).map((choice) => (
                  <button key={choice} aria-pressed={status.transcription === choice} disabled={choice === "local" && !status.local.installed} onClick={() => void put({ transcription: choice })} className={`${CHIP} ${status.transcription === choice ? ON : OFF} disabled:opacity-40`}>
                    {status.transcription === choice && <Check size={13} strokeWidth={2.25} />}
                    {choice === "local" ? "On this Mac" : "Groq"}
                  </button>
                ))}
              </div>
              {status.transcription === "groq" && <KeyField id="groq" label="Groq" url="https://console.groq.com/keys" saved={status.keys.groq} onSaved={() => void load()} />}
            </Row>

            <Row title="Downloads" done={status.searchModel === "present" && (status.local.model === "present" || status.transcription === "groq")}>
              {status.transcription === "local" && <Progress label="Speech" state={status.local.model} fraction={status.local.progress} />}
              <Progress label="Search" state={status.searchModel} />
              {status.searchModel === "failed" && (
                <button onClick={() => void fetch("/api/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "downloads" }) }).then(load)} className={SECONDARY}>
                  Try again
                </button>
              )}
            </Row>

            <Row title="Keys" optional done={KEYS.every((k) => status.keys[k.id])}>
              {KEYS.map((key) => (
                <KeyField key={key.id} id={key.id} label={key.label} use={key.use} url={key.url} saved={status.keys[key.id]} onSaved={() => void load()} />
              ))}
            </Row>

            <Row title="Folders" optional>
              {status.vaults.map((vault) => (
                <div key={vault.path} className="flex items-center gap-3 text-[14px]">
                  <span className="font-medium">{vault.name}</span>
                  <span className="text-ink-3 text-[12.5px]">Obsidian</span>
                  <button onClick={() => void linkVault(vault.path)} className={PRIMARY}>
                    Link
                  </button>
                </div>
              ))}
              <Sources />
            </Row>

            <div className="pt-6">
              <button onClick={() => void finish()} disabled={!aiDone || !transcriptionDone} className="h-10 px-5 rounded-xl bg-amber text-ink text-[14.5px] font-semibold disabled:bg-paper-2 disabled:text-ink-3">
                Start
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
