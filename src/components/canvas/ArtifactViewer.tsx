"use client";

import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, Link2, Loader2, Maximize, RectangleHorizontal, Square, X } from "lucide-react";
import { desktop } from "@/lib/desktop/client";
import { shareArtifact } from "./share";
import { useMulch } from "@/lib/mulch/client";
import { openFile } from "./NodeView";
import { useCanvasUi } from "./ui";
import { useSharingOn } from "@/components/settings/Sharing";

const BUTTON = "no-drag h-8 px-2.5 rounded-lg text-[13px] text-white/80 hover:bg-white/10 hover:text-white inline-flex items-center gap-1.5";

/**
 * An HTML or SVG artifact over the canvas, sandboxed: on a 16:9 stage by
 * default (decks are made at 16:9), or filling the window; Present shows it
 * full screen. Esc leaves full screen, then closes.
 */
export function ArtifactViewer() {
  const viewerId = useCanvasUi((s) => s.viewerId);
  const setViewer = useCanvasUi((s) => s.setViewer);
  const mulchId = useMulch((s) => s.id);
  const node = useMulch((s) => (viewerId ? s.mulch?.nodes[viewerId] : undefined));
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [fill, setFill] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [sharing, setSharing] = useState<"idle" | "busy" | "copied">("idle");
  const sharingOn = useSharingOn();

  useEffect(() => {
    if (!viewerId) return;
    // Esc leaves full screen first (the browser does that), then closes. In the app, main passes Esc on
    // even when the made page has the keyboard; one that just ended full screen does not also close.
    let leftFullscreenAt = 0;
    const escape = () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else if (Date.now() - leftFullscreenAt > 600) setViewer(undefined);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !desktop()) escape();
    };
    const onFullscreen = () => {
      if (!document.fullscreenElement) leftFullscreenAt = Date.now();
      setPresenting(!!document.fullscreenElement);
      frame.current?.focus();
    };
    const offMenu = desktop()?.onMenu?.((command) => {
      if (command === "escape") escape();
    });
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      offMenu?.();
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, [viewerId, setViewer]);
  useEffect(() => setSharing("idle"), [viewerId]);

  if (!node?.docPath || !mulchId) return null;
  async function share() {
    if (!mulchId || !node) return;
    setSharing("busy");
    const ok = await shareArtifact(mulchId, node.id);
    setSharing(ok ? "copied" : "idle");
    if (ok) setTimeout(() => setSharing("idle"), 3000);
  }
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-ink/85 backdrop-blur-sm">
      <div className={`drag h-12 shrink-0 flex items-center gap-3 ${desktop() ? "pl-[84px]" : "pl-4"} pr-3 text-white`}>
        <span className="text-[14.5px] font-semibold truncate">{node.title}</span>
        <span className="text-white/45 text-[12.5px] truncate">{node.fileName}</span>
        <div className="flex-1" />
        <button onClick={() => setFill(!fill)} className={BUTTON} title={fill ? "16:9" : "Fill the window"} aria-label={fill ? "16:9" : "Fill the window"}>
          {fill ? <RectangleHorizontal size={15} strokeWidth={1.75} /> : <Square size={14} strokeWidth={1.75} />}
        </button>
        <button onClick={() => void stage.current?.requestFullscreen().catch(() => undefined)} className={BUTTON}>
          <Maximize size={14} strokeWidth={1.75} /> Present
        </button>
        {desktop() && (
          <>
            {sharingOn && <button onClick={() => void share()} disabled={sharing === "busy"} className={BUTTON}>
              {sharing === "busy" ? <Loader2 size={14} className="animate-spin" /> : sharing === "copied" ? <Check size={14} strokeWidth={2.25} /> : <Link2 size={14} strokeWidth={1.75} />}
              {sharing === "busy" ? "Sharing" : sharing === "copied" ? "Link copied" : "Share"}
            </button>}
            <button onClick={() => openFile(mulchId, node.docPath!, "reveal")} className="no-drag p-1.5 rounded-lg text-white/70 hover:bg-white/10 hover:text-white" title="Show in Finder" aria-label="Show in Finder">
              <FolderOpen size={16} strokeWidth={1.75} />
            </button>
          </>
        )}
        <button onClick={() => setViewer(undefined)} className="no-drag p-1.5 rounded-lg text-white/70 hover:bg-white/10 hover:text-white" title="Close" aria-label="Close">
          <X size={18} strokeWidth={1.75} />
        </button>
      </div>
      {/* The stage: 16:9 as large as fits (letterboxed), or the whole area; in full screen, the whole screen. */}
      <div ref={stage} className={`flex-1 min-h-0 grid place-items-center ${presenting ? "bg-black" : "px-3 pb-3"}`} style={{ containerType: "size" }}>
        <iframe
          ref={frame}
          src={`/api/mulches/${mulchId}/${node.docPath}`}
          sandbox="allow-scripts"
          title={node.title ?? "Artifact"}
          onLoad={() => frame.current?.focus()}
          className={`bg-white border-0 ${presenting ? "" : "rounded-xl"}`}
          style={fill && !presenting ? { width: "100%", height: "100%" } : { width: "min(100cqw, 100cqh * 16 / 9)", aspectRatio: "16 / 9" }}
        />
      </div>
    </div>
  );
}
