"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, FolderPlus, History, X } from "lucide-react";
import type { Napkin } from "@/lib/napkin/types";
import { HistoryBar } from "./History";
import { useCanvasUi } from "./ui";
import { desktop } from "@/lib/desktop/client";
import { useNapkin } from "@/lib/napkin/client";
import { useSearchParams } from "next/navigation";
import { SearchPalette } from "@/components/search/SearchPalette";
import { ArtifactViewer } from "./ArtifactViewer";
import { Canvas } from "./Canvas";
import { InputBar } from "./InputBar";
import { JobStatus } from "./JobStatus";
import { SidePanel } from "./SidePanel";

function Title() {
  const napkin = useNapkin((s) => s.napkin);
  const apply = useNapkin((s) => s.apply);
  const [value, setValue] = useState<string>();
  if (!napkin) return null;
  const commit = () => {
    if (value !== undefined && value.trim() && value.trim() !== napkin.title) apply([{ op: "setTitle", title: value.trim() }]);
    setValue(undefined);
  };
  return (
    <input
      value={value ?? napkin.title}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setValue(undefined);
          (e.target as HTMLInputElement).blur();
        }
      }}
      aria-label="Title"
      className="min-w-0 w-80 bg-transparent font-semibold outline-none rounded px-1.5 py-0.5 hover:bg-paper-2 focus:bg-white"
    />
  );
}

function notify(message: string, level: "error" | "info" = "error") {
  useNapkin.setState({ notice: { level, message, at: Date.now() } });
}

/** Pick a folder for the agent to explore into this napkin. */
function AddFolder({ napkinId }: { napkinId: string }) {
  async function choose() {
    if (!desktop()) return notify("Adding a folder needs the desktop app.");
    const picked = (await (await fetch("/api/browse-directory?purpose=ingest")).json()) as { success?: boolean; cancelled?: boolean; path?: string | null; error?: string };
    if (!picked.success) return notify(picked.error || "The folder picker could not open.");
    if (picked.cancelled || !picked.path) return;
    const response = await fetch(`/api/napkins/${napkinId}/folder`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: picked.path }) });
    if (!response.ok) notify(((await response.json().catch(() => ({}))) as { error?: string }).error || "Could not add the folder.");
  }
  return (
    <button onClick={choose} className="p-1.5 rounded-md text-ink-2 hover:bg-paper-2" title="Add folder" aria-label="Add folder">
      <FolderPlus size={16} />
    </button>
  );
}

function Notice() {
  const notice = useNapkin((s) => s.notice);
  const dismiss = useNapkin((s) => s.dismissNotice);
  useEffect(() => {
    if (!notice || notice.level === "error") return;
    const timer = setTimeout(dismiss, 5000);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);
  if (!notice) return null;
  return (
    <div className={`absolute top-3 left-1/2 -translate-x-1/2 z-20 max-w-xl flex items-start gap-2 rounded-md px-3 py-2 text-sm shadow-md ${notice.level === "error" ? "bg-accent text-white" : "bg-ink text-paper"}`}>
      <span className="flex-1">{notice.message}</span>
      <button onClick={dismiss} aria-label="Close" className="opacity-70 hover:opacity-100">
        <X size={14} />
      </button>
    </div>
  );
}

export function NapkinView({ id }: { id: string }) {
  const connect = useNapkin((s) => s.connect);
  const napkin = useNapkin((s) => (s.id === id ? s.napkin : undefined));
  const connected = useNapkin((s) => s.connected);
  const error = useNapkin((s) => s.error);

  useEffect(() => connect(id), [connect, id]);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [preview, setPreview] = useState<Napkin>();
  const onPreview = useCallback((past?: Napkin) => setPreview(past), []);
  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    setPreview(undefined);
  }, []);
  useEffect(() => {
    useCanvasUi.setState({ readOnly: !!preview, editingId: undefined });
  }, [preview]);
  const shown = preview ?? napkin;

  // Arriving from a search result in another napkin: show that item once loaded.
  const params = useSearchParams();
  const focusParam = params.get("focus");
  const pageParam = params.get("page");
  const loaded = !!napkin;
  useEffect(() => {
    if (!loaded || !focusParam) return;
    const timer = setTimeout(() => useNapkin.getState().setFocus({ ids: [focusParam], ...(pageParam ? { page: Number(pageParam) } : {}) }), 600);
    return () => clearTimeout(timer);
  }, [loaded, focusParam, pageParam]);

  return (
    <main className="h-full flex flex-col">
      <header className="drag h-12 shrink-0 pl-20 pr-3 flex items-center gap-2 border-b border-line bg-paper z-10">
        <Link href="/" className="p-1.5 rounded-md text-ink-2 hover:bg-paper-2" aria-label="Home" title="Home">
          <ArrowLeft size={16} />
        </Link>
        <Title />
        <div className="flex-1" />
        {!connected && napkin && <span className="text-xs text-ink-3">Reconnecting</span>}
        {napkin && <JobStatus napkinId={id} />}
        {napkin && <AddFolder napkinId={id} />}
        {napkin && (
          <button
            onClick={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
            className={`p-1.5 rounded-md hover:bg-paper-2 ${historyOpen ? "text-accent" : "text-ink-2"}`}
            title="History"
            aria-label="History"
          >
            <History size={16} />
          </button>
        )}
      </header>
      {historyOpen && <HistoryBar napkinId={id} onPreview={onPreview} onClose={closeHistory} />}
      <div className="relative flex-1 min-h-0 flex">
        <div className="relative flex-1 min-w-0">
          <Notice />
          {error ? (
            <p className="p-8 text-sm text-ink-2">{error}</p>
          ) : shown ? (
            <>
              <Canvas napkin={shown} />
              {!preview && <InputBar napkinId={id} />}
              <ArtifactViewer />
              <SearchPalette napkinId={id} onFocus={(hit) => useNapkin.getState().setFocus({ ids: [hit.nodeId], ...(hit.page ? { page: hit.page } : {}), quote: hit.snippet.replace(/^…|…$/g, "").slice(0, 80) })} />
            </>
          ) : null}
        </div>
        <SidePanel />
      </div>
    </main>
  );
}
