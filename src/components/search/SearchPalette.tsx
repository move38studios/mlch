"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

export interface SearchResult {
  /** Empty for a file in a linked folder (then sourceId and path). */
  mulchId: string;
  /** The mulch's title, or the linked folder's name. */
  mulchTitle: string;
  sourceId?: string;
  path?: string;
  nodeId: string;
  kind: string;
  title?: string;
  snippet: string;
  page?: number;
}

/** Results for a query, debounced. `mulchId` limits to one mulch. */
export function useSearch(query: string, mulchId?: string) {
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
        const response = await fetch(`/api/search?q=${encodeURIComponent(q)}${mulchId ? `&mulch=${mulchId}` : ""}`);
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
  }, [query, mulchId]);
  return { results, loading };
}

/** A snippet as plain text: no markdown markers. */
function plain(text: string): string {
  return text
    .replace(/\\n/g, " ")
    .replace(/(^|[\s…])#{1,6}\s+/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const KIND_LABEL: Record<string, string> = {
  transcript: "said",
  doc: "file",
  link: "link",
  writeup: "write-up",
  artifact: "made",
  media: "media",
  image: "image",
  question: "question",
  search: "source",
  definition: "definition",
  example: "example",
  idea: "idea",
  note: "note",
  file: "file",
};

/** Go to a result: an item in a mulch, or a file of a linked folder (Obsidian for vault notes). */
export function openResult(router: ReturnType<typeof useRouter>, result: SearchResult) {
  if (result.sourceId && result.path) {
    void fetch("/api/sources/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId: result.sourceId, path: result.path }) });
    return;
  }
  router.push(`/n/${result.mulchId}?focus=${result.nodeId}${result.page ? `&page=${result.page}` : ""}`);
}

export function ResultList({
  results,
  showMulch,
  onPick,
  active = -1,
}: {
  results: SearchResult[];
  showMulch: boolean;
  onPick(result: SearchResult): void;
  /** The row the arrow keys are on. */
  active?: number;
}) {
  if (!results.length) return <p className="px-4 py-3 text-[14px] text-ink-3">Nothing found.</p>;
  return (
    <ul className="max-h-[60vh] overflow-auto py-1.5">
      {results.map((result, i) => (
        <li key={`${result.mulchId}/${result.nodeId}/${i}`}>
          <button
            onClick={() => onPick(result)}
            ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
            className={`w-full text-left px-4 py-2.5 hover:bg-paper-2 focus:bg-paper-2 outline-none ${i === active ? "bg-paper-2" : ""}`}
          >
            <div className="flex items-baseline gap-2 text-[12px] text-ink-3">
              <span>{KIND_LABEL[result.kind] ?? result.kind}</span>
              {result.title && <span className="truncate">{result.title}</span>}
              {result.page && <span>p.{result.page}</span>}
              {showMulch && <span className="ml-auto truncate">{result.mulchTitle}</span>}
            </div>
            <p className="text-[14px] leading-snug text-ink line-clamp-2 mt-0.5">{plain(result.snippet)}</p>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Cmd+K on a mulch: search this mulch or all of them. */
export function SearchPalette({ mulchId, onFocus }: { mulchId: string; onFocus(result: SearchResult): void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { results, loading } = useSearch(open ? query : "", all ? undefined : mulchId);
  useEffect(() => setActive(0), [results]);

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
    if (result.mulchId === mulchId) onFocus(result);
    else openResult(router, result);
  };
  return (
    <div className="absolute inset-0 z-40 bg-paper/50 backdrop-blur-[2px] flex justify-center pt-[12vh]" onMouseDown={() => setOpen(false)}>
      <div className="float w-[min(640px,90%)] h-fit rounded-2xl overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-4 border-b border-line">
          <Search size={17} strokeWidth={1.75} className="text-ink-3" />
          <input
            ref={input}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const count = results?.length ?? 0;
                if (count) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
              } else if (e.key === "Enter" && results?.[active]) pick(results[active]);
            }}
            placeholder="Search"
            aria-label="Search"
            className="flex-1 py-3.5 outline-none text-[17px] bg-transparent placeholder:text-ink-3"
          />
          <div className="flex shrink-0 rounded-lg bg-paper-2 p-0.5 text-[12.5px]">
            {[false, true].map((value) => (
              <button
                key={String(value)}
                onClick={() => setAll(value)}
                aria-pressed={all === value}
                className={`px-2 py-1 rounded-md ${all === value ? "bg-chrome text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-ink-3 hover:text-ink"}`}
              >
                {value ? "All" : "This one"}
              </button>
            ))}
          </div>
          <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink" title="Close" aria-label="Close">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        {loading && !results && <p className="px-4 py-3 text-[14px] text-ink-3">Searching</p>}
        {results && <ResultList results={results} showMulch={all} onPick={pick} active={active} />}
      </div>
    </div>
  );
}
