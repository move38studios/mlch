"use client";

import { useCallback, useEffect, useState } from "react";
import { desktop } from "@/lib/desktop/client";
import type { SourceStatus } from "@/lib/sources/sources";

interface SourceView {
  id: string;
  path: string;
  name: string;
  mode: "auto" | "asked";
  writeFolder?: string;
  vault: boolean;
  status: SourceStatus | null;
}

const CHIP = "h-7 px-2.5 rounded-full text-[12.5px]";
const ON = "border-[1.5px] border-ink text-ink font-medium";
const OFF = "border border-line text-ink-3 hover:border-line-2 hover:text-ink";
const SECONDARY = "h-8 px-2.5 rounded-lg text-[13px] text-ink-2 hover:bg-paper-2 hover:text-ink";
const PRIMARY = "h-8 px-3 rounded-lg bg-ink text-white text-[13px] font-medium";

function statusText(status: SourceStatus | null): string {
  if (!status) return "";
  if (status.state === "indexing") return status.files ? `Indexing, ${status.done} read of ${status.files}` : "Indexing";
  if (status.state === "missing") return "Folder not found";
  if (status.state === "error") return status.error ?? "Indexing failed";
  return `${status.files} files`;
}

/** Folders linked once, searched from every mulch. */
export function Sources() {
  const [sources, setSources] = useState<SourceView[]>();
  const [error, setError] = useState<string>();

  const apply = useCallback(async (response: Response) => {
    const body = (await response.json().catch(() => ({}))) as { sources?: SourceView[]; error?: string };
    if (!response.ok || !body.sources) setError(body.error ?? "Something went wrong.");
    else {
      setError(undefined);
      setSources(body.sources);
    }
  }, []);
  const load = useCallback(() => fetch("/api/sources").then(apply), [apply]);
  useEffect(() => void load(), [load]);

  const indexing = sources?.some((s) => s.status?.state === "indexing");
  useEffect(() => {
    if (!indexing) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [indexing, load]);

  async function add() {
    if (!desktop()) return setError("Linking a folder needs the desktop app.");
    const picked = (await (await fetch("/api/browse-directory?purpose=ingest")).json()) as { success?: boolean; cancelled?: boolean; path?: string | null; error?: string };
    if (!picked.success) return setError(picked.error || "The folder picker could not open.");
    if (picked.cancelled || !picked.path) return;
    await apply(await fetch("/api/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: picked.path }) }));
  }
  const patch = (id: string, body: object) => fetch(`/api/sources/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(apply);
  const remove = (id: string) => fetch(`/api/sources/${id}`, { method: "DELETE" }).then(apply);

  return (
    <div className="space-y-4">
      {sources?.map((source) => (
        <div key={source.id} className="rounded-xl border border-line px-4 py-3">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[14.5px] font-medium truncate">{source.name}</span>
            {source.vault && <span className="text-[12.5px] text-ink-3 shrink-0">Obsidian</span>}
            <span className="ml-auto text-[12.5px] text-ink-3 shrink-0">{statusText(source.status)}</span>
          </div>
          <div className="text-[12.5px] text-ink-3 truncate mt-0.5">{source.path}</div>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {(["auto", "asked"] as const).map((mode) => (
              <button key={mode} aria-pressed={source.mode === mode} onClick={() => void patch(source.id, { mode })} className={`${CHIP} ${source.mode === mode ? ON : OFF}`}>
                {mode === "auto" ? "Use without asking" : "Only when asked"}
              </button>
            ))}
            <label className="flex items-center gap-1.5 text-[13px] text-ink-2 ml-2">
              <input type="checkbox" checked={source.writeFolder !== undefined} onChange={(e) => void patch(source.id, { writeFolder: e.target.checked ? "mlch" : null })} />
              mlch can add notes here
            </label>
            {source.writeFolder !== undefined && (
              <input
                defaultValue={source.writeFolder}
                onBlur={(e) => e.target.value.trim() !== source.writeFolder && void patch(source.id, { writeFolder: e.target.value })}
                aria-label="Folder for new notes"
                className="h-7 w-32 rounded-lg border border-line bg-chrome px-2 text-[13px] outline-none focus:border-ink"
              />
            )}
            <button onClick={() => void remove(source.id)} className={`${SECONDARY} ml-auto`}>
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <button onClick={() => void add()} className={PRIMARY}>
          Add folder
        </button>
        {error && <span className="text-[13px] text-danger">{error}</span>}
      </div>
    </div>
  );
}
