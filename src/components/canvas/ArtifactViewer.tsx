"use client";

import { useEffect, useRef } from "react";
import { FolderOpen, X } from "lucide-react";
import { useMulch } from "@/lib/mulch/client";
import { openFile } from "./NodeView";
import { useCanvasUi } from "./ui";

/** An HTML or SVG artifact full-window over the canvas, sandboxed. Esc closes. */
export function ArtifactViewer() {
  const viewerId = useCanvasUi((s) => s.viewerId);
  const setViewer = useCanvasUi((s) => s.setViewer);
  const mulchId = useMulch((s) => s.id);
  const node = useMulch((s) => (viewerId ? s.mulch?.nodes[viewerId] : undefined));
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!viewerId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewer(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerId, setViewer]);

  if (!node?.docPath || !mulchId) return null;
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-ink/85 backdrop-blur-sm">
      <div className="drag h-12 shrink-0 flex items-center gap-3 pl-[84px] pr-3 text-white">
        <span className="text-[14.5px] font-semibold truncate">{node.title}</span>
        <span className="text-white/45 text-[12.5px] truncate">{node.fileName}</span>
        <div className="flex-1" />
        <button onClick={() => openFile(mulchId, node.docPath!, "reveal")} className="p-1.5 rounded-lg text-white/70 hover:bg-white/10 hover:text-white" title="Show in Finder" aria-label="Show in Finder">
          <FolderOpen size={16} strokeWidth={1.75} />
        </button>
        <button onClick={() => setViewer(undefined)} className="p-1.5 rounded-lg text-white/70 hover:bg-white/10 hover:text-white" title="Close" aria-label="Close">
          <X size={18} strokeWidth={1.75} />
        </button>
      </div>
      <iframe
        ref={frame}
        src={`/api/mulches/${mulchId}/${node.docPath}`}
        sandbox="allow-scripts"
        title={node.title ?? "Artifact"}
        onLoad={() => frame.current?.focus()}
        className="flex-1 mx-3 mb-3 rounded-xl bg-white border-0"
      />
    </div>
  );
}
