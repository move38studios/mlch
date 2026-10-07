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
    <div className="absolute inset-0 z-30 flex flex-col bg-ink/80 backdrop-blur-sm">
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 text-paper text-sm">
        <span className="font-medium truncate">{node.title}</span>
        <span className="text-paper/50 text-xs truncate">{node.fileName}</span>
        <div className="flex-1" />
        <button onClick={() => openFile(mulchId, node.docPath!, "reveal")} className="p-1.5 rounded hover:bg-white/10" title="Show in Finder" aria-label="Show in Finder">
          <FolderOpen size={15} />
        </button>
        <button onClick={() => setViewer(undefined)} className="p-1.5 rounded hover:bg-white/10" title="Close" aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <iframe
        ref={frame}
        src={`/api/mulches/${mulchId}/${node.docPath}`}
        sandbox="allow-scripts"
        title={node.title ?? "Artifact"}
        onLoad={() => frame.current?.focus()}
        className="flex-1 mx-3 mb-3 rounded-md bg-white border-0"
      />
    </div>
  );
}
