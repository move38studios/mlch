"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

export interface SearchResult {
  napkinId: string;
  napkinTitle: string;
  nodeId: string;
  kind: string;
  title?: string;
  snippet: string;
  page?: number;
}

/** Results for a query, debounced. `napkinId` limits to one napkin. */
export function useSearch(query: string, napkinId?: string) {
  const [results, setResults] = useState<SearchResult[]>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(q)}${napkinId ? `&napkin=${napkinId}` : ""}`);
        const body = (await response.json()) as { hits?: SearchResult[] };
        if (!cancelled) setResults(body.hits ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, napkinId]);
  return { results, loading };
}

const KIND_LABEL: Record<string, string> = {
  transcript: "Said",
  doc: "File",
  link: "Link",
  writeup: "Write-up",
  artifact: "File",
  media: "Media",
  image: "Image",
  question: "Question",
  search: "Search",
  definition: "Definition",
  example: "Example",
  idea: "Idea",
  note: "Note",
};

export function ResultList({ results, showNapkin, onPick }: { results: SearchResult[]; showNapkin: boolean; onPick(result: SearchResult): void }) {
  if (!results.length) return <p className="px-4 py-3 text-sm text-ink-3">Nothing found.</p>;
  return (
    <ul className="max-h-[60vh] overflow-auto py-1">
      {results.map((result, i) => (
        <li key={`${result.napkinId}/${result.nodeId}/${i}`}>
          <button onClick={() => onPick(result)} className="w-full text-left px-4 py-2 hover:bg-paper-2 focus:bg-paper-2 outline-none">
            <div className="flex items-baseline gap-2 text-[11px] text-ink-3">
              <span className="uppercase tracking-wider font-medium">{KIND_LABEL[result.kind] ?? result.kind}</span>
              {result.title && <span className="truncate">{result.title}</span>}
              {result.page && <span>p.{result.page}</span>}
              {showNapkin && <span className="ml-auto truncate">{result.napkinTitle}</span>}
            </div>
            <p className="text-sm text-ink line-clamp-2">{result.snippet}</p>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Cmd+K on a napkin: search this napkin or all of them. */
export function SearchPalette({ napkinId, onFocus }: { napkinId: string; onFocus(result: SearchResult): void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { results, loading } = useSearch(open ? query : "", all ? undefined : napkinId);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "f")) {
        event.preventDefault();
        setOpen(true);
        setTimeout(() => input.current?.select(), 0);
      } else if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;
  const pick = (result: SearchResult) => {
    setOpen(false);
    if (result.napkinId === napkinId) onFocus(result);
    else router.push(`/n/${result.napkinId}?focus=${result.nodeId}${result.page ? `&page=${result.page}` : ""}`);
  };
  return (
    <div className="absolute inset-0 z-40 bg-ink/10 flex justify-center pt-[12vh]" onMouseDown={() => setOpen(false)}>
      <div className="w-[min(640px,90%)] h-fit rounded-xl border border-line bg-white shadow-2xl overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 border-b border-line">
          <Search size={15} className="text-ink-3" />
          <input
            ref={input}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results?.[0]) pick(results[0]);
            }}
            placeholder="Search"
            aria-label="Search"
            className="flex-1 py-3 outline-none text-[15px] bg-transparent"
          />
          <div className="flex text-xs rounded-md bg-paper-2 p-0.5">
            {[false, true].map((value) => (
              <button key={String(value)} onClick={() => setAll(value)} className={`px-2 py-0.5 rounded ${all === value ? "bg-white shadow-sm" : "text-ink-3"}`}>
                {value ? "All" : "This one"}
              </button>
            ))}
          </div>
          <button onClick={() => setOpen(false)} className="p-1 text-ink-3 hover:text-ink" aria-label="Close">
            <X size={15} />
          </button>
        </div>
        {loading && !results && <p className="px-4 py-3 text-sm text-ink-3">Searching</p>}
        {results && <ResultList results={results} showNapkin={all} onPick={pick} />}
      </div>
    </div>
  );
}
