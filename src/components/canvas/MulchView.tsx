"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, FolderPlus, History, X } from "lucide-react";
import type { Mulch } from "@/lib/mulch/types";
import { HistoryBar } from "./History";
import { useCanvasUi } from "./ui";
import { desktop } from "@/lib/desktop/client";
import { useMulch } from "@/lib/mulch/client";
import { useSearchParams } from "next/navigation";
import { SearchPalette } from "@/components/search/SearchPalette";
import { ArtifactViewer } from "./ArtifactViewer";
import { Canvas } from "./Canvas";
import { InputBar } from "./InputBar";
import { JobStatus } from "./JobStatus";
import { SidePanel } from "./SidePanel";

function Title() {
  const mulch = useMulch((s) => s.mulch);
  const apply = useMulch((s) => s.apply);
  const [value, setValue] = useState<string>();
  if (!mulch) return null;
  const commit = () => {
    if (value !== undefined && value.trim() && value.trim() !== mulch.title) apply([{ op: "setTitle", title: value.trim() }]);
    setValue(undefined);
  };
  return (
    <input
      value={value ?? mulch.title}
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
      className="min-w-[8ch] max-w-[44vw] field-sizing-content bg-transparent text-[14.5px] font-semibold tracking-[-0.005em] outline-none rounded-lg px-1.5 py-1 hover:bg-paper-2 focus:bg-paper-2"
    />
  );
}

function notify(message: string, level: "error" | "info" = "error") {
  useMulch.setState({ notice: { level, message, at: Date.now() } });
}

/** Pick a folder for the agent to explore into this mulch. */
function AddFolder({ mulchId }: { mulchId: string }) {
  async function choose() {
    if (!desktop()) return notify("Adding a folder needs the desktop app.");
    const picked = (await (await fetch("/api/browse-directory?purpose=ingest")).json()) as { success?: boolean; cancelled?: boolean; path?: string | null; error?: string };
    if (!picked.success) return notify(picked.error || "The folder picker could not open.");
    if (picked.cancelled || !picked.path) return;
    const response = await fetch(`/api/mulches/${mulchId}/folder`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: picked.path }) });
    if (!response.ok) notify(((await response.json().catch(() => ({}))) as { error?: string }).error || "Could not add the folder.");
  }
  return (
    <button onClick={choose} className="p-1.5 rounded-lg text-ink-2 hover:bg-paper-2 hover:text-ink" title="Add folder" aria-label="Add folder">
      <FolderPlus size={16} strokeWidth={1.75} />
    </button>
  );
}

function Notice() {
  const notice = useMulch((s) => s.notice);
  const dismiss = useMulch((s) => s.dismissNotice);
  useEffect(() => {
    if (!notice || notice.level === "error") return;
    const timer = setTimeout(dismiss, 5000);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);
  if (!notice) return null;
  return (
    <div className={`absolute top-[60px] left-1/2 -translate-x-1/2 z-20 max-w-xl flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-[13.5px] shadow-lg ${notice.level === "error" ? "bg-danger text-white" : "bg-ink text-white"}`}>
      <span className="flex-1">{notice.message}</span>
      <button onClick={dismiss} aria-label="Close" className="opacity-70 hover:opacity-100">
        <X size={14} />
      </button>
    </div>
  );
}

export function MulchView({ id }: { id: string }) {
  const connect = useMulch((s) => s.connect);
  const mulch = useMulch((s) => (s.id === id ? s.mulch : undefined));
  const connected = useMulch((s) => s.connected);
  const error = useMulch((s) => s.error);

  useEffect(() => connect(id), [connect, id]);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [preview, setPreview] = useState<Mulch>();
  const onPreview = useCallback((past?: Mulch) => setPreview(past), []);
  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    setPreview(undefined);
  }, []);
  useEffect(() => {
    useCanvasUi.setState({ readOnly: !!preview, editingId: undefined });
  }, [preview]);
  const shown = preview ?? mulch;

  // Arriving from a search result in another mulch: show that item once loaded.
  const params = useSearchParams();
  const focusParam = params.get("focus");
  const pageParam = params.get("page");
  const loaded = !!mulch;
  useEffect(() => {
    if (!loaded || !focusParam) return;
    const timer = setTimeout(() => useMulch.getState().setFocus({ ids: [focusParam], ...(pageParam ? { page: Number(pageParam) } : {}) }), 600);
    return () => clearTimeout(timer);
  }, [loaded, focusParam, pageParam]);

  return (
    <main className="h-full flex">
      <div className="relative flex-1 min-w-0">
        {error ? (
          <p className="pt-24 px-8 text-sm text-ink-2">{error}</p>
        ) : shown ? (
          <>
            <Canvas mulch={shown} />
            {!preview && <InputBar mulchId={id} />}
            <ArtifactViewer />
            <SearchPalette mulchId={id} onFocus={(hit) => useMulch.getState().setFocus({ ids: [hit.nodeId], ...(hit.page ? { page: hit.page } : {}), quote: hit.snippet.replace(/^…|…$/g, "").slice(0, 80) })} />
          </>
        ) : null}
        {/* Floating controls over the canvas; the strip behind them drags the window. */}
        <header className="drag absolute inset-x-0 top-0 h-[52px] pl-[84px] pr-3 flex items-center gap-2 z-10 pointer-events-none">
          <div className="no-drag pointer-events-auto float rounded-xl h-9 flex items-center pl-1 pr-1.5 gap-0.5 min-w-0">
            <Link href="/" className="p-1.5 rounded-lg text-ink-2 hover:bg-paper-2 hover:text-ink" aria-label="Home" title="Home">
              <ArrowLeft size={16} strokeWidth={1.75} />
            </Link>
            <Title />
          </div>
          {!connected && mulch && <span className="pointer-events-auto text-xs text-ink-3">Reconnecting</span>}
          <div className="flex-1" />
          {mulch && (
            <div className="no-drag pointer-events-auto float rounded-xl h-9 flex items-center px-1 gap-0.5">
              <JobStatus mulchId={id} />
              <AddFolder mulchId={id} />
              <button
                onClick={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
                className={`p-1.5 rounded-lg hover:bg-paper-2 ${historyOpen ? "bg-amber text-ink hover:bg-amber" : "text-ink-2 hover:text-ink"}`}
                title="History"
                aria-label="History"
              >
                <History size={16} strokeWidth={1.75} />
              </button>
            </div>
          )}
        </header>
        {historyOpen && <HistoryBar mulchId={id} onPreview={onPreview} onClose={closeHistory} />}
        <Notice />
      </div>
      <SidePanel />
    </main>
  );
}
