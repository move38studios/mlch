"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { FOCUS_SEARCH } from "@/components/desktop/SearchKey";
import { Archive, ArchiveRestore, Plus, Search, Settings, Trash2 } from "lucide-react";
import { Scribble, Wordmark } from "@/components/brand/Scribble";
import Link from "next/link";
import { useSearch } from "@/components/search/SearchPalette";
import { HomeList } from "./HomeList";
import { formatDateTime } from "@/lib/format";
import type { MulchSummary } from "@/lib/mulch/types";

/** Archived mulches, folded away under the list: bring back, or delete for good (with their share links). */
function ArchivedList({ mulches, confirming, setConfirming, restore, remove }: { mulches: MulchSummary[]; confirming?: string; setConfirming: (id?: string) => void; restore: (id: string) => void; remove: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!mulches.length) return null;
  return (
    <div className="mt-8">
      <button onClick={() => setOpen(!open)} className="text-[13px] text-ink-3 hover:text-ink">
        Archived ({mulches.length})
      </button>
      {open && (
        <ul className="-mx-3 mt-2">
          {mulches.map((mulch) => (
            <li key={mulch.id} className="flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-paper-2">
              <span className="flex-1 min-w-0 truncate text-[15px] text-ink-2">{mulch.title}</span>
              <span className="text-[12.5px] text-ink-3 tabular-nums shrink-0">{formatDateTime(mulch.archivedAt!)}</span>
              <button onClick={() => restore(mulch.id)} className="px-2 py-1 rounded-lg text-[12.5px] text-ink-2 hover:bg-line hover:text-ink inline-flex items-center gap-1">
                <ArchiveRestore size={13} strokeWidth={1.75} /> Restore
              </button>
              {confirming === mulch.id ? (
                <button onClick={() => remove(mulch.id)} className="px-2.5 py-1 rounded-lg bg-danger text-white text-[12.5px] font-medium">
                  {mulch.shares ? "Delete with its share links" : "Delete for good"}
                </button>
              ) : (
                <button onClick={() => setConfirming(mulch.id)} className="p-1.5 rounded-lg text-ink-3 hover:text-danger" aria-label="Delete" title="Delete">
                  <Trash2 size={14} strokeWidth={1.75} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Home() {
  const router = useRouter();
  const [mulches, setMulches] = useState<MulchSummary[] | undefined>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const { results } = useSearch(query, undefined, 40);
  const searchField = useRef<HTMLInputElement>(null);
  const loaded = mulches !== undefined;

  // ⌘K (SearchKey): the field takes focus, also when home was opened for it.
  useEffect(() => {
    const focus = () => searchField.current?.focus();
    window.addEventListener(FOCUS_SEARCH, focus);
    if (new URLSearchParams(window.location.search).has("search")) focus();
    return () => window.removeEventListener(FOCUS_SEARCH, focus);
  }, [loaded]);

  // First run in the desktop app: the checklist.
  useEffect(() => {
    void fetch("/api/onboarding")
      .then(
        (r) => r.json() as Promise<{ onboarded?: boolean; desktop?: boolean }>,
      )
      .then((body) => {
        if (body.desktop && body.onboarded === false)
          router.replace("/welcome");
      })
      .catch(() => {});
  }, [router]);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/mulches");
      const body = (await response.json()) as {
        mulches?: MulchSummary[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error);
      setMulches(body.mulches ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Work keeps running in the background: keep the list current while it does, and when coming back.
  const working = mulches?.some((m) => m.activity?.working) ?? false;
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", refresh);
    const timer = working ? setInterval(refresh, 3000) : undefined;
    return () => {
      window.removeEventListener("focus", refresh);
      clearInterval(timer);
    };
  }, [load, working]);

  async function create() {
    setCreating(true);
    try {
      const response = await fetch("/api/mulches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await response.json()) as {
        mulch?: { id: string };
        error?: string;
      };
      if (!response.ok || !body.mulch) throw new Error(body.error);
      router.push(`/n/${body.mulch.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  }

  async function remove(id: string) {
    setConfirming(undefined);
    await fetch(`/api/mulches/${id}`, { method: "DELETE" });
    await load();
  }

  /** Archive (asking about share links when there are any), or bring back. */
  async function archive(id: string, archived: boolean, stopShares = false) {
    setConfirming(undefined);
    await fetch(`/api/mulches/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived, stopShares }) });
    await load();
  }
  const active = mulches?.filter((m) => !m.archivedAt);
  const archivedList = mulches?.filter((m) => m.archivedAt) ?? [];

  return (
    <main className="min-h-full flex flex-col">
      <header className="drag h-[52px] shrink-0 pl-20 pr-3 flex items-center">
        <div className="flex-1" />
        <Link
          href="/settings"
          className="p-2 rounded-lg text-ink-2 hover:bg-paper-2 hover:text-ink"
          aria-label="Settings"
          title="Settings"
        >
          <Settings size={17} strokeWidth={1.75} />
        </Link>
      </header>
      {active && active.length === 0 ? (
        // Nothing yet: the wordmark and New, centred; nothing to search.
        <div className="flex-1 flex flex-col items-center justify-center gap-10 pb-[12vh]">
          <Wordmark className="h-14 w-auto" />
          <Scribble which="bottom" className="w-40 text-ink/15 -my-4" />
          <button
            onClick={create}
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-xl bg-amber text-ink h-12 px-6 text-[16px] font-semibold hover:brightness-95 active:brightness-90 disabled:opacity-50"
          >
            <Plus size={18} strokeWidth={2.25} /> New
          </button>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="w-full max-w-[720px] px-8 text-center">
            <ArchivedList mulches={archivedList} confirming={confirming} setConfirming={setConfirming} restore={(id) => archive(id, false)} remove={remove} />
          </div>
        </div>
      ) : (
        <div className="w-full max-w-[720px] mx-auto px-8 pt-6 pb-16">
          <Wordmark className="block h-11 w-auto mb-10 mx-auto" />
          <div className="flex items-center gap-3 mb-8">
            <div className="relative flex-1">
              <Search
                size={15}
                strokeWidth={1.75}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
              />
              <input
                ref={searchField}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search"
                className="w-full rounded-xl border border-line bg-chrome pl-10 pr-3 h-11 text-[15px] outline-none placeholder:text-ink-3 focus:border-ink"
              />
            </div>
            <button
              onClick={create}
              disabled={creating}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber text-ink h-11 px-4 text-[15px] font-semibold hover:brightness-95 active:brightness-90 disabled:opacity-50"
            >
              <Plus size={17} strokeWidth={2.25} /> New
            </button>
          </div>
          {error && <p className="text-sm text-danger mb-4">{error}</p>}
          <HomeList
            mulches={mulches ?? []}
            query={query}
            results={results}
            field={searchField}
            onClear={() => setQuery("")}
            renderActions={(mulch) =>
              confirming === mulch.id ? (
                // Archiving something that is shared: keep its links working, or turn them off.
                <span className="mr-2 flex items-center gap-1.5 text-[12.5px] text-ink-2 shrink-0">
                  {mulch.shares === 1 ? "1 share link:" : `${mulch.shares} share links:`}
                  <button onClick={() => archive(mulch.id, true)} className="px-2 py-1 rounded-lg hover:bg-line text-ink">
                    Keep working
                  </button>
                  <button onClick={() => archive(mulch.id, true, true)} className="px-2 py-1 rounded-lg bg-ink text-white">
                    Turn off
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => (mulch.shares ? setConfirming(mulch.id) : archive(mulch.id, true))}
                  className="mr-2 p-1.5 rounded-lg text-ink-3 opacity-0 group-hover:opacity-100 hover:text-ink focus-visible:opacity-100"
                  aria-label="Archive"
                  title="Archive"
                >
                  <Archive size={15} strokeWidth={1.75} />
                </button>
              )
            }
          />
          <ArchivedList mulches={archivedList} confirming={confirming} setConfirming={setConfirming} restore={(id) => archive(id, false)} remove={remove} />
        </div>
      )}
    </main>
  );
}
