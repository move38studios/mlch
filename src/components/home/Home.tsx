"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Plus, Search, Settings, Trash2 } from "lucide-react";
import { Scribble, Wordmark } from "@/components/brand/Scribble";
import Link from "next/link";
import {
  openResult,
  ResultList,
  useSearch,
} from "@/components/search/SearchPalette";
import { formatDateTime } from "@/lib/format";
import type { MulchSummary } from "@/lib/mulch/types";

export function Home() {
  const router = useRouter();
  const [mulches, setMulches] = useState<MulchSummary[] | undefined>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const { results } = useSearch(query);

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
      {mulches && mulches.length === 0 ? (
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
          {results && (
            <div className="mb-8 rounded-xl float overflow-hidden">
              <ResultList
                results={results}
                showMulch
                onPick={(hit) => openResult(router, hit)}
              />
            </div>
          )}
          {error && <p className="text-sm text-danger mb-4">{error}</p>}
          <ul className="-mx-3">
            {mulches?.map((mulch) => (
              <li
                key={mulch.id}
                className="group flex items-center rounded-xl hover:bg-paper-2"
              >
                <Link
                  href={`/n/${mulch.id}`}
                  className="flex-1 min-w-0 flex items-baseline gap-4 py-3 px-3"
                >
                  <span className="truncate text-[17px] font-medium tracking-[-0.01em]">
                    {mulch.title}
                  </span>
                  {/* Something running; results not yet seen; a failure. */}
                  {mulch.activity?.working ? (
                    <span
                      className="shrink-0 self-center"
                      title="Working"
                      aria-label="Working"
                    >
                      <Scribble
                        which="bottom"
                        mode="loop"
                        strokeWidth={11}
                        className="h-3 w-8 text-ink"
                      />
                    </span>
                  ) : null}
                  {mulch.activity?.unseen ? (
                    <span
                      className="h-2 w-2 shrink-0 self-center rounded-full bg-amber"
                      title="New results"
                      aria-label="New results"
                    />
                  ) : null}
                  {mulch.activity?.failed ? (
                    <span
                      className="h-2 w-2 shrink-0 self-center rounded-full bg-danger"
                      title="Failed"
                      aria-label="Failed"
                    />
                  ) : null}
                  <span className="flex-1" />
                  <span className="text-[13px] text-ink-3 shrink-0 tabular-nums">
                    {mulch.nodeCount} items
                  </span>
                  <span className="text-[13px] text-ink-3 shrink-0 tabular-nums w-36 text-right">
                    {formatDateTime(mulch.updatedAt)}
                  </span>
                </Link>
                {confirming === mulch.id ? (
                  <button
                    onClick={() => remove(mulch.id)}
                    className="mr-2 text-xs font-medium px-2.5 py-1 rounded-lg bg-danger text-white"
                  >
                    Delete
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirming(mulch.id)}
                    className="mr-2 p-1.5 rounded-lg text-ink-3 opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                    aria-label="Delete"
                    title="Delete"
                  >
                    <Trash2 size={15} strokeWidth={1.75} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
