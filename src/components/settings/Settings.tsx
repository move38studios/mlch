"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, Loader2 } from "lucide-react";
import type { AgentHarnessId, AgentHarnessStatus } from "@/lib/agent/types";
import { desktop } from "@/lib/desktop/client";

type Lane = "fast" | "slow" | "command";
interface SettingsData {
  harness: AgentHarnessId;
  models: Record<AgentHarnessId, Partial<Record<Lane, string>>>;
  enrich: string[];
  dailySpendCapUsd: number;
}
interface SettingsView {
  settings: SettingsData;
  keys: { groq: boolean; firecrawl: boolean; fal: boolean; exa: boolean };
  spentToday: number;
  usageToday: Record<string, { turns: number; inputTokens: number; outputTokens: number }>;
  desktop: boolean;
  defaults: Record<AgentHarnessId, Partial<Record<Lane, string>>>;
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
  { id: "napkins", label: "Links to other napkins" },
];
const KEYS: Array<{ id: "groq" | "firecrawl" | "fal" | "exa"; label: string }> = [
  { id: "groq", label: "Groq API key" },
  { id: "firecrawl", label: "Firecrawl API key" },
  { id: "fal", label: "fal API key" },
  { id: "exa", label: "Exa API key" },
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
  if (!rows.length) return <p className="text-sm text-ink-3">No AI turns today.</p>;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
  return (
    <table className="text-sm tabular-nums">
      <thead className="text-ink-3 text-xs">
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
              <td className="pr-6">{harness === "claude" ? "Claude Code" : "Codex"} · {LANE_NAMES[lane] ?? lane}</td>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="py-6 border-b border-line">
      <h2 className="text-sm font-semibold mb-4">{title}</h2>
      {children}
    </section>
  );
}

function KeyField({ id, label, set, stored, onSaved }: { id: string; label: string; set: boolean; stored: boolean; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const bridge = desktop();
  async function save(next: string | null) {
    if (!bridge) return;
    const result = next === null ? await bridge.credentials.delete(id) : await bridge.credentials.write({ [id]: next });
    if (!result.ok) setError(result.error);
    else {
      setError(undefined);
      setValue("");
      onSaved();
    }
  }
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-40 text-sm">{label}</span>
      <span className={`text-xs w-24 ${set ? "text-ink-2" : "text-ink-3"}`}>{stored ? "Set" : set ? "Set in .env" : "Not set"}</span>
      {bridge ? (
        <>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={set ? "Replace" : "Paste key"}
            className="flex-1 rounded-md border border-line bg-white px-2 py-1 text-sm outline-none focus:border-ink/40"
          />
          <button onClick={() => save(value.trim())} disabled={!value.trim()} className="text-sm px-2.5 py-1 rounded-md bg-ink text-paper disabled:opacity-30">
            Save
          </button>
          {stored && (
            <button onClick={() => save(null)} className="text-sm px-2 py-1 rounded-md text-ink-2 hover:bg-paper-2">
              Remove
            </button>
          )}
        </>
      ) : (
        <span className="text-xs text-ink-3">.env.local</span>
      )}
      {error && <span className="text-xs text-accent">{error}</span>}
    </div>
  );
}

export function Settings() {
  const [view, setView] = useState<SettingsView>();
  const [harnesses, setHarnesses] = useState<AgentHarnessStatus[]>();
  const [saved, setSaved] = useState(false);
  const [stored, setStored] = useState<Record<string, boolean>>({});
  const [report, setReport] = useState<string>();

  const loadSettings = useCallback(async () => {
    setView((await (await fetch("/api/settings")).json()) as SettingsView);
    const result = await desktop()?.credentials.status();
    if (result?.ok) setStored(result.value);
  }, []);
  const loadStatus = useCallback(async () => {
    const body = (await (await fetch("/api/agent/status")).json()) as { harnesses?: AgentHarnessStatus[] };
    setHarnesses(body.harnesses ?? []);
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadStatus();
  }, [loadSettings, loadStatus]);

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
      <header className="drag h-12 pl-20 pr-4 flex items-center gap-2 border-b border-line">
        <Link href="/" className="p-1.5 rounded-md text-ink-2 hover:bg-paper-2" aria-label="Napkins" title="Napkins">
          <ArrowLeft size={16} />
        </Link>
        <span className="font-semibold">Settings</span>
        {saved && (
          <span className="text-xs text-ink-3 inline-flex items-center gap-1">
            <Check size={12} /> Saved
          </span>
        )}
      </header>
      <div className="max-w-2xl mx-auto px-6 pb-16">
        <Section title="AI">
          {!harnesses && (
            <p className="text-sm text-ink-3 inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Checking
            </p>
          )}
          <div className="space-y-2">
            {harnesses?.map((h) => (
              <label key={h.id} className="flex items-start gap-3 rounded-lg border border-line bg-white px-3 py-2.5 cursor-pointer">
                <input type="radio" name="harness" checked={settings?.harness === h.id} onChange={() => update({ harness: h.id })} className="mt-1" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">
                    {h.label} {h.version && <span className="text-ink-3 font-normal">{h.version}</span>}
                  </div>
                  <div className="text-xs text-ink-2 mt-0.5">
                    {h.problem ? (
                      <span className="text-accent">{h.problem}</span>
                    ) : (
                      <>
                        Signed in{h.account?.plan ? `, ${h.account.plan}` : ""}
                        {h.account?.email ? ` (${h.account.email})` : ""}
                        {h.planUsage?.length ? (
                          <span className="block mt-0.5 text-ink-3">
                            Plan used: {h.planUsage.map((w) => `${WINDOW_NAMES[w.name] ?? w.name} ${w.percent}%`).join(" · ")}
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
                {h.installed && !h.signedIn && (
                  <button onClick={(e) => { e.preventDefault(); void signIn(h.id); }} className="text-sm px-2.5 py-1 rounded-md bg-ink text-paper">
                    Sign in
                  </button>
                )}
              </label>
            ))}
          </div>
          {active && settings && (
            <div className="mt-5 space-y-2">
              {LANES.map((lane) => (
                <div key={lane.id} className="flex items-center gap-3">
                  <span className="w-28 text-sm">{lane.label}</span>
                  <select
                    value={settings.models[settings.harness]?.[lane.id] ?? ""}
                    onChange={(e) =>
                      update({ models: { ...settings.models, [settings.harness]: { ...settings.models[settings.harness], [lane.id]: e.target.value || undefined } } })
                    }
                    className="rounded-md border border-line bg-white px-2 py-1 text-sm"
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
        {settings && (
          <Section title="Enrichment">
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {ENRICH.map((item) => (
                <label key={item.id} className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.enrich.includes(item.id)}
                    onChange={(e) =>
                      update({ enrich: e.target.checked ? [...settings.enrich, item.id] : settings.enrich.filter((x) => x !== item.id) })
                    }
                  />
                  {item.label}
                </label>
              ))}
            </div>
          </Section>
        )}
        {view && settings && (
          <Section title="Generation spend">
            <div className="flex items-center gap-3 text-sm">
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
                className="w-24 rounded-md border border-line bg-white px-2 py-1 text-sm"
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
        <Section title="Diagnostics">
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                const response = await fetch("/api/diagnostics", { method: "POST" });
                const body = (await response.json()) as { file?: string; error?: string };
                setReport(body.file ?? body.error);
              }}
              className="text-sm px-2.5 py-1 rounded-md bg-ink text-paper"
            >
              Save diagnostic report
            </button>
            {desktop() && (
              <button onClick={() => void desktop()?.openLogs()} className="text-sm px-2.5 py-1 rounded-md text-ink-2 hover:bg-paper-2">
                Open logs folder
              </button>
            )}
          </div>
          {report && <p className="text-xs text-ink-3 mt-2 break-all">{report}</p>}
        </Section>
        {view && (
          <Section title="Keys">
            {KEYS.map((key) => (
              <KeyField key={key.id} id={key.id} label={key.label} set={view.keys[key.id]} stored={!!stored[key.id]} onSaved={loadSettings} />
            ))}
          </Section>
        )}
      </div>
    </main>
  );
}
