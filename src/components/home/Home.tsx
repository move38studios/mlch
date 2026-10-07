"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Plus, Settings, Trash2 } from "lucide-react";
import Link from "next/link";
import { ResultList, useSearch } from "@/components/search/SearchPalette";
import { formatDateTime } from "@/lib/format";
import type { NapkinSummary } from "@/lib/napkin/types";

export function Home() {
  const router = useRouter();
  const [napkins, setNapkins] = useState<NapkinSummary[] | undefined>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const { results } = useSearch(query);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/napkins");
      const body = (await response.json()) as { napkins?: NapkinSummary[]; error?: string };
      if (!response.ok) throw new Error(body.error);
      setNapkins(body.napkins ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setCreating(true);
    try {
      const response = await fetch("/api/napkins", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = (await response.json()) as { napkin?: { id: string }; error?: string };
      if (!response.ok || !body.napkin) throw new Error(body.error);
      router.push(`/n/${body.napkin.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  }

  async function remove(id: string) {
    setConfirming(undefined);
    await fetch(`/api/napkins/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <main className="min-h-full flex flex-col">
      <header className="drag h-12 shrink-0 pl-20 pr-3 flex items-center gap-3 border-b border-line">
        <span className="font-semibold tracking-tight">Mulch</span>
        <div className="flex-1" />
        <Link href="/settings" className="p-2 rounded-md text-ink-2 hover:bg-paper-2" aria-label="Settings" title="Settings">
          <Settings size={16} />
        </Link>
      </header>
      <div className="w-full max-w-3xl mx-auto px-6 py-10">
        <div className="flex items-center mb-6">
          <div className="flex-1" />
          <button
            onClick={create}
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-md bg-ink text-paper px-3 py-1.5 text-sm font-medium hover:bg-ink/85 disabled:opacity-50"
          >
            <Plus size={15} /> New
          </button>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search"
          className="w-full mb-6 rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-ink/40"
        />
        {results && (
          <div className="mb-8 rounded-lg border border-line bg-white overflow-hidden">
            <ResultList results={results} showNapkin onPick={(hit) => router.push(`/n/${hit.napkinId}?focus=${hit.nodeId}${hit.page ? `&page=${hit.page}` : ""}`)} />
          </div>
        )}
        {error && <p className="text-sm text-accent mb-4">{error}</p>}
        {napkins && napkins.length === 0 && <p className="text-sm text-ink-3">Nothing yet.</p>}
        <ul className="divide-y divide-line border-y border-line">
          {napkins?.map((napkin) => (
            <li key={napkin.id} className="group flex items-center">
              <Link href={`/n/${napkin.id}`} className="flex-1 min-w-0 flex items-baseline gap-4 py-3 px-1 hover:bg-paper-2/60">
                <span className="truncate font-medium">{napkin.title}</span>
                <span className="text-xs text-ink-3 shrink-0">{napkin.nodeCount} items</span>
                <span className="flex-1" />
                <span className="text-xs text-ink-3 shrink-0 tabular-nums">{formatDateTime(napkin.updatedAt)}</span>
              </Link>
              {confirming === napkin.id ? (
                <button onClick={() => remove(napkin.id)} className="ml-2 text-xs px-2 py-1 rounded bg-accent text-white">
                  Delete
                </button>
              ) : (
                <button
                  onClick={() => setConfirming(napkin.id)}
                  className="ml-2 p-1.5 rounded text-ink-3 opacity-0 group-hover:opacity-100 hover:text-accent"
                  aria-label="Delete"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
