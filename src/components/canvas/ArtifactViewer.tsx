"use client";

import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, Link2, Loader2, Maximize, MessageSquare, X } from "lucide-react";
import { commentsOn, useComments } from "./Comments";
import { desktop } from "@/lib/desktop/client";
import { shareArtifact } from "./share";
import { useMulch } from "@/lib/mulch/client";
import { openFile } from "./NodeView";
import { useCanvasUi } from "./ui";
import { useSharingOn } from "@/components/settings/Sharing";
import { useArtifactKind } from "./artifactKind";

const BUTTON = "no-drag h-8 px-2.5 rounded-lg text-[13px] text-white/80 hover:bg-white/10 hover:text-white inline-flex items-center gap-1.5";

/**
 * An HTML or SVG artifact over the canvas, sandboxed, filling the stage. A deck
 * letterboxes its own 1920x1080 slides (src/lib/artifacts/deck.ts) and has
 * Present (full screen) where the browser can do it; a page scrolls, edge to
 * edge on a phone. Esc leaves full screen, then closes.
 */
/** In a browser, a click counts for 5 s; one on this page (opening the viewer, the slide bar) mustn't count for the file. */
const ACTIVATION_MS = 5000;
let ownInputAt = 0;
let ownPressAt = 0;
if (typeof window !== "undefined") {
  for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, () => (ownInputAt = Date.now()), true);
  window.addEventListener("pointerdown", () => (ownPressAt = Date.now()), true);
}

/**
 * A web link clicked in the file: a new tab, only right after a click in the file itself. In the app, main
 * knows where the mouse was pressed, so it checks that it was on the file; in a browser, the page's activation.
 */
function openLink(value: unknown, frame: HTMLIFrameElement | null, shownAt: number) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value) || !frame) return;
  const open = desktop()?.openLink;
  if (open) {
    // A press on this page (outside the file) comes after main saw it; one on the file never reaches this page.
    const { x, y, width, height } = frame.getBoundingClientRect();
    void open(value, { x, y, width, height }, Math.max(shownAt, ownPressAt)).catch(() => undefined);
    return;
  }
  if (!navigator.userActivation?.isActive || Date.now() - ownInputAt < ACTIVATION_MS) return;
  window.open(value, "_blank", "noopener,noreferrer");
}

export function ArtifactViewer() {
  const viewerId = useCanvasUi((s) => s.viewerId);
  const setViewer = useCanvasUi((s) => s.setViewer);
  const mulchId = useMulch((s) => s.id);
  const node = useMulch((s) => (viewerId ? s.mulch?.nodes[viewerId] : undefined));
  const frame = useRef<HTMLIFrameElement>(null);
  // When the file was shown: a press before it (opening the viewer) wasn't on it.
  const shownAt = useRef(0);
  const stage = useRef<HTMLDivElement>(null);
  const [presenting, setPresenting] = useState(false);
  const [sharing, setSharing] = useState<"idle" | "busy" | "copied">("idle");
  const sharingOn = useSharingOn();
  const src = node?.docPath && mulchId ? `/api/mulches/${mulchId}/${node.docPath}` : undefined;
  const kind = useArtifactKind(node, src);
  // The slide showing (the deck player says), for a comment on it.
  const [slide, setSlide] = useState<number>();
  const [count, setCount] = useState<number>();
  useEffect(() => {
    setSlide(undefined);
    setCount(undefined);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { mlchDeckSlide?: unknown; mlchDeckCount?: unknown; mlchOpenLink?: unknown } | null;
      // A web link clicked in it: a new tab (the browser, in the app).
      if (data?.mlchOpenLink !== undefined) openLink(data.mlchOpenLink, frame.current, shownAt.current);
      const n = data?.mlchDeckSlide;
      if (typeof n === "number" && Number.isInteger(n) && n > 0 && n < 1000) setSlide(n);
      const total = data?.mlchDeckCount;
      if (typeof total === "number" && Number.isInteger(total) && total > 0 && total < 1000) {
        setCount(total);
        // The bar under the deck counts; the deck's own counter steps aside.
        frame.current?.contentWindow?.postMessage({ mlchDeckCounter: false }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [viewerId]);
  const showComments = useComments((s) => s.show);
  const openComments = useMulch((s) => (viewerId ? commentsOn(s.mulch, viewerId).filter((c) => !c.resolvedAt).length : 0));

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

  if (!node?.docPath || !mulchId || !src) return null;
  // Full screen only where it does something (not on an iPhone).
  const canPresent = kind === "deck" && document.fullscreenEnabled;
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
        <span className="text-white/45 text-[12.5px] truncate max-sm:hidden">{node.fileName}</span>
        <div className="flex-1" />
        {canPresent && (
          <button onClick={() => void stage.current?.requestFullscreen().catch(() => undefined)} className={BUTTON}>
            <Maximize size={14} strokeWidth={1.75} /> Present
          </button>
        )}
        <button
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            showComments({ nodeId: node.id, x: box.right - 300, y: box.bottom + 6, ...(kind === "deck" && slide ? { at: { slide } } : {}) });
          }}
          className={BUTTON}
          aria-label="Comments"
          title="Comments"
        >
          <MessageSquare size={14} strokeWidth={1.75} />
          {openComments > 0 && <span className="tabular-nums">{openComments}</span>}
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
      {/* The stage: the whole area (a deck letterboxes its slides itself); in full screen, the whole screen; on a phone, edge to edge. */}
      <div ref={stage} data-kind={kind} className={`flex-1 min-h-0 flex ${presenting ? "bg-black" : "px-3 pb-3 max-sm:p-0"}`}>
        <iframe
          ref={frame}
          src={src}
          sandbox="allow-scripts"
          title={node.title ?? "Artifact"}
          onLoad={() => {
            shownAt.current = Date.now();
            frame.current?.focus();
          }}
          className={`flex-1 min-w-0 h-full border-0 ${kind === "deck" ? "bg-black" : "bg-white"} ${presenting ? "" : "rounded-xl max-sm:rounded-none"}`}
        />
      </div>
      {!presenting && kind === "deck" && count && count > 1 && slide && (
        <SlideBar slide={slide} count={count} go={(n) => frame.current?.contentWindow?.postMessage({ mlchDeckGo: n }, "*")} />
      )}
    </div>
  );
}

/** Where you are in a deck, and a way to jump: a hairline with a mark; click or drag along it. */
function SlideBar({ slide, count, go }: { slide: number; count: number; go: (n: number) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const at = (clientX: number) => {
    const box = bar.current?.getBoundingClientRect();
    if (!box) return slide;
    return Math.min(count, Math.max(1, Math.floor(((clientX - box.left) / box.width) * count) + 1));
  };
  const [hover, setHover] = useState<number>();
  return (
    <div className="no-drag shrink-0 h-8 px-4 flex items-center gap-3 text-white/45 text-[11.5px] tabular-nums">
      <div
        ref={bar}
        className="group relative flex-1 h-full cursor-pointer"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          go(at(event.clientX));
        }}
        onPointerMove={(event) => {
          setHover(at(event.clientX));
          if (event.buttons) go(at(event.clientX));
        }}
        onPointerLeave={() => setHover(undefined)}
        role="slider"
        aria-label="Slide"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={slide}
      >
        <div className="absolute inset-x-0 top-1/2 h-px bg-white/20 group-hover:h-0.5 transition-[height] motion-reduce:transition-none" />
        <div className="absolute top-1/2 -translate-y-1/2 h-0.5 group-hover:h-1 rounded-full bg-white/85" style={{ left: `${((slide - 1) / count) * 100}%`, width: `${Math.max(100 / count, 0.6)}%` }} />
        {hover !== undefined && hover !== slide && (
          <div className="absolute -top-3 -translate-x-1/2 text-white/70 pointer-events-none" style={{ left: `${((hover - 0.5) / count) * 100}%` }}>
            {hover}
          </div>
        )}
      </div>
      <span>
        {slide} / {count}
      </span>
    </div>
  );
}
