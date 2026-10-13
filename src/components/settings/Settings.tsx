"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, ChevronRight, Loader2 } from "lucide-react";
import type { AgentHarnessId, AgentHarnessStatus } from "@/lib/agent/types";
import { desktop } from "@/lib/desktop/client";
import { Sources } from "./Sources";
import { KeyField } from "./KeyField";
import { AiAccess, type AuthMode } from "./AiAccess";
import { TranscriptionChoice } from "./TranscriptionSection";
import { SharingChoice } from "./Sharing";

type Lane = "fast" | "slow" | "command";
interface SettingsData {
  harness: AgentHarnessId;
  models: Record<AgentHarnessId, Partial<Record<Lane, string>>>;
  enrich: string[];
  prompts: Record<string, string | undefined>;
  style: string;
  dailySpendCapUsd: number;
  transcription: "groq" | "local";
  agentAuth: Record<AgentHarnessId, AuthMode>;
  subscriptionConsent: Partial<Record<AgentHarnessId, number>>;
}
interface SettingsView {
  settings: SettingsData;
  keys: { groq: boolean; firecrawl: boolean; fal: boolean; exa: boolean; anthropic: boolean; openai: boolean };
  spentToday: number;
  usageToday: Record<string, { turns: number; inputTokens: number; outputTokens: number }>;
  desktop: boolean;
  defaults: Record<AgentHarnessId, Partial<Record<Lane, string>>>;
  promptDefaults: Record<string, string>;
}

const LANES: Array<{ id: Lane; label: string }> = [
  { id: "fast", label: "Capture" },
  { id: "slow", label: "Enrich" },
  { id: "command", label: "Instructions" },
];
const ENRICH: Array<{ id: string; label: string }> = [
  { id: "search", label: "Web search" },
  { id: "definitions", label: "Definitions" },
  { id: "examples", label: "Examples" },
  { id: "related", label: "Related ideas" },
  { id: "questions", label: "Questions" },
  { id: "mulches", label: "Links to your mulches and sources" },
];
const PROMPTS: Array<{ id: string; label: string; sub?: boolean }> = [
  { id: "base", label: "General" },
  { id: "fast", label: "Capture" },
  { id: "call", label: "Calls" },
  { id: "slow", label: "Enrich" },
  ...ENRICH.map((item) => ({ id: `enrich:${item.id}`, label: item.label, sub: true })),
  { id: "command", label: "Instructions" },
  { id: "research", label: "Research" },
  { id: "maker", label: "Making files" },
  { id: "ingest", label: "Documents" },
  { id: "image", label: "Images" },
  { id: "folder", label: "Folders" },
];
const KEYS: Array<{ id: "groq" | "firecrawl" | "fal" | "exa" | "gemini"; label: string; use: string; url: string }> = [
  { id: "exa", label: "Exa", use: "Web search, for enrichment and research.", url: "https://dashboard.exa.ai/api-keys" },
  { id: "firecrawl", label: "Firecrawl", use: "Reads web pages and documents in full.", url: "https://www.firecrawl.dev/app/api-keys" },
  { id: "fal", label: "fal", use: "Makes images, video, voice and music.", url: "https://fal.ai/dashboard/keys" },
  { id: "gemini", label: "Gemini", use: "Watches YouTube videos you add, for a summary and a transcript.", url: "https://aistudio.google.com/apikey" },
  { id: "groq", label: "Groq", use: "Speech to text, when Transcription is set to Groq.", url: "https://console.groq.com/keys" },
];

const WINDOW_NAMES: Record<string, string> = {
  five_hour: "5 hours",
  seven_day: "week",
  seven_day_opus: "week, Opus",
  seven_day_sonnet: "week, Sonnet",
};

const LANE_NAMES: Record<string, string> = { fast: "Capture", slow: "Enrich", command: "Instructions" };

function UsageTable({ usage }: { usage: SettingsView["usageToday"] }) {
  const rows = Object.entries(usage);
  if (!rows.length) return <p className="text-[14px] text-ink-3">No AI turns today.</p>;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
  return (
    <table className="text-[14px] tabular-nums">
      <thead className="text-ink-3 text-[12.5px]">
        <tr>
          <th className="text-left font-normal pr-6 pb-1"></th>
          <th className="text-right font-normal pr-6 pb-1">Turns</th>
          <th className="text-right font-normal pr-6 pb-1">Tokens in</th>
          <th className="text-right font-normal pb-1">Tokens out</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, value]) => {
          const [harness, lane] = key.split("/");
          return (
            <tr key={key}>
              <td className="pr-6">{harness === "claude" ? "Claude Code" : "Codex"}, {LANE_NAMES[lane] ?? lane}</td>
              <td className="text-right pr-6">{value.turns}</td>
              <td className="text-right pr-6">{k(value.inputTokens)}</td>
              <td className="text-right">{k(value.outputTokens)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The desktop app starting with the Mac (for the menu bar). */
function OpenAtLogin() {
  const [on, setOn] = useState<boolean>();
  useEffect(() => {
    void desktop()?.openAtLogin?.().then(setOn);
  }, []);
  if (on === undefined) return null;
  return (
    <Section title="App">
      <label className="flex items-center gap-2 text-[14px]">
        <input type="checkbox" checked={on} onChange={(e) => void desktop()?.openAtLogin?.(e.target.checked).then(setOn)} />
        Open at login
      </label>
      <Link href="/welcome" className="inline-block mt-3 text-[13px] text-ink-2 hover:text-ink underline underline-offset-2">
        Setup checklist
      </Link>
    </Section>
  );
}

function Section({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="py-7 border-t border-line first:border-t-0 scroll-mt-4">
      <h2 className="text-[15px] font-semibold tracking-[-0.005em] mb-4">{title}</h2>
      {children}
    </section>
  );
}

const FIELD = "h-9 rounded-lg border border-line bg-chrome px-2.5 text-[14px] outline-none focus:border-ink";
const PRIMARY = "h-8 px-3 rounded-lg bg-ink text-white text-[13px] font-medium disabled:bg-paper-2 disabled:text-ink-3";
const SECONDARY = "h-8 px-2.5 rounded-lg text-[13px] text-ink-2 hover:bg-paper-2 hover:text-ink";

/** One editable prompt part. Saved on blur; empty or unchanged text means the default. */
function PromptField({ label, sub, value, fallback, onSave }: { label: string; sub?: boolean; value?: string; fallback: string; onSave: (next: string | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value ?? fallback);
  useEffect(() => setText(value ?? fallback), [value, fallback]);
  function save() {
    const trimmed = text.trim();
    const next = !trimmed || trimmed === fallback.trim() ? undefined : text;
    if (next !== value) onSave(next);
  }
  return (
    <div className={sub ? "pl-5" : ""}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center gap-2 py-1.5 text-left text-[14px] hover:text-ink">
        <ChevronRight size={14} className={`text-ink-3 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
        <span>{label}</span>
        {value !== undefined && <span className="text-[12.5px] text-ink-3">Edited</span>}
      </button>
      {open && (
        <div className="pl-5 pb-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={save}
            rows={Math.min(24, Math.max(4, text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 90)), 1)))}
            spellCheck={false}
            className="w-full rounded-lg border border-line bg-chrome px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-ink resize-y"
          />
          {value !== undefined && (
            <button onClick={() => onSave(undefined)} className={`mt-1 -ml-2.5 ${SECONDARY}`}>
              Reset to default
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Settings() {
  const [view, setView] = useState<SettingsView>();
  const [harnesses, setHarnesses] = useState<AgentHarnessStatus[]>();
  const [saved, setSaved] = useState(false);
  const router = useRouter();
  const [scrolled, setScrolled] = useState(false);
  // The desktop bridge exists only in the browser: decided after the first render so it matches the server's.
  const [inApp, setInApp] = useState(false);
  useEffect(() => setInApp(!!desktop()), []);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    // Back: Esc (when not typing) and ⌘[.
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]");
      if ((event.key === "Escape" && !typing) || (event.metaKey && event.key === "[")) {
        event.preventDefault();
        router.push("/");
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKey);
    };
  }, [router]);
  const [report, setReport] = useState<string>();

  const loadSettings = useCallback(async () => {
    setView((await (await fetch("/api/settings")).json()) as SettingsView);
  }, []);
  const loadStatus = useCallback(async () => {
    const body = (await (await fetch("/api/agent/status")).json()) as { harnesses?: AgentHarnessStatus[] };
    setHarnesses(body.harnesses ?? []);
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadStatus();
  }, [loadSettings, loadStatus]);
  // Opened at a section (e.g. /settings#sharing from the Share menu): scroll to it once the page has its content.
  const loaded = !!view;
  useEffect(() => {
    if (loaded && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [loaded]);

  async function update(patch: Partial<SettingsData>) {
    const response = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    setView((await response.json()) as SettingsView);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function signIn(harness: AgentHarnessId) {
    await fetch("/api/agent/sign-in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ harness }) });
    setTimeout(loadStatus, 3000);
  }

  const settings = view?.settings;
  const active = harnesses?.find((h) => h.id === settings?.harness);

  return (
    <main className="min-h-full">
      {/* The bar stays at the top (and is the window's drag area); a hairline once the page has scrolled. */}
      <header className={`drag sticky top-0 z-20 bg-paper ${scrolled ? "border-b border-line" : "border-b border-transparent"}`}>
        <div className="max-w-2xl mx-auto px-6 pt-12 pb-2 flex items-center gap-2">
          <Link href="/" className="no-drag -ml-2 p-1.5 rounded-lg text-ink-2 hover:bg-paper-2 hover:text-ink" aria-label="Home" title="Home">
            <ArrowLeft size={18} strokeWidth={1.75} />
          </Link>
          <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Settings</h1>
          {saved && (
            <span className="ml-2 text-[12.5px] text-ink-3 inline-flex items-center gap-1">
              <Check size={12} /> Saved
            </span>
          )}
        </div>
      </header>
      <div className="max-w-2xl mx-auto px-6 pb-16">
        <Section title="AI">
          {!harnesses && (
            <p className="text-[14px] text-ink-3 inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Checking
            </p>
          )}
          <div className="space-y-2">
            {harnesses?.map((h) => (
              <label
                key={h.id}
                className={`flex items-start gap-3 rounded-xl bg-chrome px-4 py-3 cursor-pointer ${settings?.harness === h.id ? "border-[1.5px] border-ink" : "border border-line hover:border-line-2"}`}
              >
                <input type="radio" name="harness" checked={settings?.harness === h.id} onChange={() => update({ harness: h.id })} className="mt-1" />
                <div className="flex-1 min-w-0">
                  <div className="text-[14.5px] font-medium">
                    {h.label} {h.version && <span className="text-ink-3 font-normal">{h.version}</span>}
                  </div>
                  <div className="text-[12.5px] text-ink-2 mt-0.5">
                    {h.problem ? (
                      <span className="text-danger">{h.problem}</span>
                    ) : (
                      <>
                        Signed in{h.account?.plan ? `, ${h.account.plan}` : ""}
                        {h.account?.email ? ` (${h.account.email})` : ""}
                        {h.planUsage?.length ? (
                          <span className="block mt-0.5 text-ink-3">
                            Plan used: {h.planUsage.map((w) => `${WINDOW_NAMES[w.name] ?? w.name} ${w.percent}%`).join(", ")}
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
                {h.cli?.state === "missing" && (
                  <button onClick={(e) => { e.preventDefault(); void fetch("/api/agent/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: h.id }) }).then(() => setTimeout(loadStatus, 1500)); }} className={PRIMARY}>
                    Download
                  </button>
                )}
                {h.installed && !h.signedIn && h.auth !== "apiKey" && (
                  <button onClick={(e) => { e.preventDefault(); void signIn(h.id); }} className={PRIMARY}>
                    Sign in
                  </button>
                )}
              </label>
            ))}
          </div>
          <div className="mt-4 space-y-4">
            {settings && view && harnesses?.map((h) => (
              <div key={h.id}>
                <div className="text-[13px] font-medium mb-1.5">{h.label}</div>
                <AiAccess
                  id={h.id}
                  mode={settings.agentAuth[h.id]}
                  consented={!!settings.subscriptionConsent[h.id]}
                  onChange={(change) => {
                    if ("keySaved" in change) return void loadSettings().then(loadStatus);
                    if (change.agentAuth) void update({ agentAuth: { ...settings.agentAuth, [h.id]: change.agentAuth } }).then(loadStatus);
                    if (change.consent !== undefined) void update({ subscriptionConsent: { ...settings.subscriptionConsent, [h.id]: change.consent ? Date.now() : undefined } });
                  }}
                />
              </div>
            ))}
          </div>
          {active && settings && (
            <div className="mt-5 space-y-2">
              {LANES.map((lane) => (
                <div key={lane.id} className="flex items-center gap-3">
                  <span className="w-28 text-[14px]">{lane.label}</span>
                  <select
                    value={settings.models[settings.harness]?.[lane.id] ?? ""}
                    onChange={(e) =>
                      update({ models: { ...settings.models, [settings.harness]: { ...settings.models[settings.harness], [lane.id]: e.target.value || undefined } } })
                    }
                    className={FIELD}
                  >
                    <option value="">{view?.defaults[settings.harness]?.[lane.id] ? `Default (${view.defaults[settings.harness][lane.id]})` : "Default"}</option>
                    {active.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
        </Section>
        <Section title="Sharing" id="sharing">
          <SharingChoice />
        </Section>
        <Section title="Sources">
          <Sources />
        </Section>
        {settings && (
          <Section title="Enrichment">
            <div className="flex flex-wrap gap-2">
              {ENRICH.map((item) => {
                const on = settings.enrich.includes(item.id);
                return (
                  <button
                    key={item.id}
                    aria-pressed={on}
                    onClick={() => update({ enrich: on ? settings.enrich.filter((x) => x !== item.id) : [...settings.enrich, item.id] })}
                    className={`h-8 px-3 rounded-full text-[13px] inline-flex items-center gap-1.5 ${on ? "border-[1.5px] border-ink text-ink font-medium" : "border border-line text-ink-3 hover:border-line-2 hover:text-ink"}`}
                  >
                    {on && <Check size={13} strokeWidth={2.25} />}
                    {item.label}
                  </button>
                );
              })}
            </div>
          </Section>
        )}
        {settings && view?.desktop && (
          <Section title="Transcription">
            <TranscriptionChoice value={settings.transcription} onChange={(transcription) => void update({ transcription })} />
          </Section>
        )}
        {view && settings && (
          <Section title="Style">
            <p className="text-[13px] text-ink-3 mb-2.5">How decks, documents, pages and images should look: colours, fonts, tone, your logo&rsquo;s place on this Mac. Used for everything the AI makes.</p>
            <textarea
              defaultValue={settings.style}
              onBlur={(e) => e.target.value !== settings.style && void update({ style: e.target.value })}
              rows={5}
              placeholder={"Colours: #0B3D2E and #F2E8D5. Headings in Fraunces, text in Inter.\nLogo: ~/Brand/logo.svg, top left on title slides.\nFew words per slide."}
              aria-label="Style"
              className="w-full rounded-lg border border-line bg-chrome px-3 py-2 text-[13.5px] leading-relaxed outline-none focus:border-ink resize-y placeholder:text-ink-3"
            />
          </Section>
        )}
        {view && settings && (
          <Section title="Prompts">
            {PROMPTS.map((item) => (
              <PromptField
                key={item.id}
                label={item.label}
                sub={item.sub}
                value={settings.prompts[item.id]}
                fallback={view.promptDefaults[item.id]}
                onSave={(next) => update({ prompts: { ...settings.prompts, [item.id]: next } })}
              />
            ))}
          </Section>
        )}
        {view && settings && (
          <Section title="fal spend">
            <p className="text-[13px] text-ink-3 mb-2.5">What images, video, voice and music made with your fal key cost today. Over the cap, mlch asks before making more.</p>
            <div className="flex items-center gap-3 text-[14px]">
              <span className="w-40">Daily cap (USD)</span>
              <input
                type="number"
                min={0}
                step={1}
                defaultValue={settings.dailySpendCapUsd}
                onBlur={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value >= 0 && value !== settings.dailySpendCapUsd) void update({ dailySpendCapUsd: value });
                }}
                className={`w-24 ${FIELD}`}
              />
              <span className="text-ink-2">Today: ${view.spentToday.toFixed(2)}</span>
            </div>
          </Section>
        )}
        {view && (
          <Section title="AI usage today">
            <UsageTable usage={view.usageToday} />
          </Section>
        )}
        <OpenAtLogin />
        <Section title="Diagnostics">
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                const response = await fetch("/api/diagnostics", { method: "POST" });
                const body = (await response.json()) as { file?: string; error?: string };
                setReport(body.file ?? body.error);
              }}
              className={PRIMARY}
            >
              Save diagnostic report
            </button>
            {inApp && (
              <button onClick={() => void desktop()?.openLogs()} className={SECONDARY}>
                Open logs folder
              </button>
            )}
          </div>
          {report && <p className="text-[12.5px] text-ink-3 mt-2 break-all">{report}</p>}
        </Section>
        {view && (
          <Section title="Keys">
            <div className="space-y-5">
              {KEYS.map((key) => (
                <div key={key.id}>
                  <div className="flex items-baseline gap-2 mb-1.5">
                    <span className="text-[14px] font-medium">{key.label}</span>
                    <span className="text-[12.5px] text-ink-3">{key.use}</span>
                  </div>
                  <KeyField name={key.id} label={key.label} url={key.url} onChanged={loadSettings} />
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </main>
  );
}
