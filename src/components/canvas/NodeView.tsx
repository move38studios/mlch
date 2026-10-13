"use client";

import { useSharingOn } from "@/components/settings/Sharing";
import { memo, useEffect, useRef, useState } from "react";
import { Handle, NodeResizeControl, Position, ResizeControlVariant, type NodeProps, type Node } from "@xyflow/react";

const SIDES = [["t", Position.Top], ["r", Position.Right], ["b", Position.Bottom], ["l", Position.Left]] as const;
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ExternalLink, FileText, Link2, Maximize2, Play } from "lucide-react";
import { videoEmbed, type VideoEmbed } from "@/lib/ingest/video";
import { formatDateTime } from "@/lib/format";
import { useResolvedRef } from "./refs";
import { shareArtifact } from "./share";
import { desktop } from "@/lib/desktop/client";
import { useMulch } from "@/lib/mulch/client";
import { jitter } from "@/lib/mulch/place";
import type { MulchNode } from "@/lib/mulch/types";
import { hasThumbnail } from "@/lib/artifacts/thumbnails";
import { KIND_STYLES } from "./kinds";
import { MediaBody } from "./MediaBody";
import { useCanvasUi } from "./ui";

export type MulchFlowNode = Node<{ node: MulchNode; mulchId: string; fresh: boolean }, "mulch">;

/** The person's own words (said, typed or touched) carry an ink outline; AI material a hairline. */
function outline(node: MulchNode, tinted?: boolean): string {
  const own = node.origin === "user" || node.origin.startsWith("speech:") || !!node.userTouched;
  if (node.kind === "note") return "border border-transparent"; // a post-it: its colour says whose it is
  if (own && (node.kind === "idea" || node.kind === "question")) return "border-[1.5px] border-ink";
  return tinted ? "border border-transparent" : "border border-line";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Editor({ node, onDone }: { node: MulchNode; onDone: () => void }) {
  const apply = useMulch((s) => s.apply);
  const [text, setText] = useState(node.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const commit = () => {
    if (text !== node.text) {
      apply(text.trim() ? [{ op: "updateNode", id: node.id, patch: { text, userTouched: true, updatedAt: Date.now() } }] : [{ op: "removeNode", id: node.id }]);
    }
    onDone();
  };
  return (
    <textarea
      ref={ref}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          commit();
        }
      }}
      className="nodrag nowheel w-full min-h-[3em] resize-none bg-transparent outline-none field-sizing-content"
    />
  );
}

export async function openFile(mulchId: string, docPath: string, action: "open" | "reveal") {
  await fetch(`/api/mulches/${mulchId}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ docPath }) });
}

/** Share a made file: says so while the link is made, then that it is copied. */
function ShareButton({ mulchId, nodeId }: { mulchId: string; nodeId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "copied">("idle");
  if (!useSharingOn()) return null;
  return (
    <button
      onClick={async () => {
        setState("busy");
        const ok = await shareArtifact(mulchId, nodeId);
        setState(ok ? "copied" : "idle");
        if (ok) setTimeout(() => setState("idle"), 3000);
      }}
      disabled={state === "busy"}
      className="px-2 py-1 rounded text-xs text-ink-2 hover:bg-paper-2 inline-flex items-center gap-1"
    >
      {state === "copied" && <Check size={11} strokeWidth={2.5} />}
      {state === "busy" ? "Sharing" : state === "copied" ? "Link copied" : "Share"}
    </button>
  );
}

/** A YouTube or Vimeo video: its poster, and the player after a click (so nothing loads until asked). */
function VideoPlayer({ video, poster, title }: { video: VideoEmbed; poster?: string; title?: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="nodrag nowheel relative aspect-video overflow-hidden rounded-t-[inherit] bg-ink">
      {playing ? (
        <iframe
          src={video.embed}
          title={title ?? "Video"}
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="absolute inset-0 h-full w-full border-0"
        />
      ) : (
        <button onClick={() => setPlaying(true)} className="absolute inset-0 grid place-items-center group/play" aria-label="Play">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {poster && <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />}
          <span className="relative h-12 w-12 rounded-full bg-white/90 grid place-items-center shadow-lg group-hover/play:scale-105 transition-transform">
            <Play size={20} strokeWidth={2} className="ml-0.5 fill-ink" />
          </span>
        </button>
      )}
    </div>
  );
}

function ArtifactBody({ node, mulchId }: { node: MulchNode; mulchId: string }) {
  const setViewer = useCanvasUi((s) => s.setViewer);
  const ext = node.docPath?.split(".").pop() ?? "";
  const viewable = ext === "html" || ext === "svg";
  const src = node.docPath ? `/api/mulches/${mulchId}/${node.docPath}` : undefined;
  // Decks and documents: a Quick Look preview of the first page (desktop app only).
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumb = node.docPath && hasThumbnail(node.docPath) && !thumbFailed ? `/api/mulches/${mulchId}/thumbnail?doc=${encodeURIComponent(node.docPath)}&v=${node.updatedAt ?? node.createdAt}` : undefined;
  const label = ext === "pptx" ? "PowerPoint" : ext.toUpperCase();
  return (
    <div>
      {viewable && src && (
        <div className="relative aspect-video overflow-hidden rounded-t-[inherit] border-b border-line bg-paper-2">
          {/* A live, non-interactive thumbnail: the page at 1280px wide, scaled down. */}
          <iframe
            src={src}
            sandbox="allow-scripts"
            tabIndex={-1}
            title={node.title ?? "Preview"}
            className="pointer-events-none absolute left-0 top-0 origin-top-left border-0 bg-white"
            style={{ width: 1280, height: 720, transform: `scale(${(node.w ?? 320) / 1280})` }}
          />
        </div>
      )}
      {thumb && (
        <div className="aspect-video overflow-hidden rounded-t-[inherit] border-b border-line bg-paper-2 grid place-items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumb} alt="" draggable={false} onError={() => setThumbFailed(true)} className="max-h-full max-w-full object-contain shadow-[0_1px_3px_rgba(0,0,0,0.12)]" />
        </div>
      )}
      <div className="px-3.5 py-3">
        <div className="flex items-center gap-1.5 mb-1 text-[12px] text-ink-3">
          <FileText size={11} /> {label}
          <span className="normal-case tracking-normal truncate">{node.fileName}</span>
        </div>
        {node.title && <div className="font-semibold mb-1 leading-snug">{node.title}</div>}
        <p className="whitespace-pre-wrap text-ink-2 line-clamp-3">{node.text}</p>
        {node.docPath && (
          <div className="nodrag flex gap-1.5 mt-2.5">
            {viewable ? (
              <button onClick={() => setViewer(node.id)} className="px-2 py-1 rounded bg-ink text-paper text-xs">
                Open
              </button>
            ) : (
              <button onClick={() => openFile(mulchId, node.docPath!, "open")} className="px-2 py-1 rounded bg-ink text-paper text-xs">
                Open
              </button>
            )}
            {desktop() && <ShareButton mulchId={mulchId} nodeId={node.id} />}
            {desktop() && (
              <button onClick={() => openFile(mulchId, node.docPath!, "reveal")} className="px-2 py-1 rounded text-xs text-ink-2 hover:bg-paper-2">
                Show in Finder
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A link to an item in another mulch or a note in a linked folder, shown live; the panel opens it. */
function RefBody({ node }: { node: MulchNode }) {
  // In a shared canvas a link card keeps only the linked item's title (shares.ts sharedMulch).
  const shared = !!node.ref && ("mulchId" in node.ref ? node.ref.mulchId : node.ref.sourceId) === "shared";
  const target = useResolvedRef(shared ? undefined : node.ref);
  if (shared) {
    return (
      <div className="px-3.5 py-3">
        <div className="flex items-center gap-1.5 mb-1 text-[12px] text-ink-3">
          <Link2 size={12} strokeWidth={1.75} className="shrink-0" />
          <span>Linked item, not shared</span>
        </div>
        {node.title && <div className="font-semibold leading-[1.3]">{node.title}</div>}
      </div>
    );
  }
  const gone = target && !target.exists;
  const title = target?.title ?? node.title;
  return (
    <div className={`px-3.5 py-3 ${gone ? "opacity-55" : ""}`}>
      <div className="flex items-center gap-1.5 mb-1 text-[12px] text-ink-3 min-w-0">
        <Link2 size={12} strokeWidth={1.75} className="shrink-0" />
        <span className="truncate">{target?.place || (node.ref && "sourceId" in node.ref ? node.ref.path : "")}</span>
        {target?.updatedAt && !gone && <span className="shrink-0">{formatDateTime(target.updatedAt)}</span>}
      </div>
      {title && <div className="font-semibold mb-0.5 leading-[1.3]">{title}</div>}
      {gone ? <p className="text-ink-3">Removed</p> : target?.text && <p className="whitespace-pre-wrap text-ink-2 line-clamp-3">{target.text}</p>}
    </div>
  );
}

function Body({ node, mulchId }: { node: MulchNode; mulchId: string }) {
  const style = KIND_STYLES[node.kind];
  if (node.kind === "ref") return <RefBody node={node} />;
  if (node.kind === "artifact") return <ArtifactBody node={node} mulchId={mulchId} />;
  if (node.kind === "media") return <MediaBody node={node} mulchId={mulchId} />;
  const video = node.kind === "link" ? videoEmbed(node.url) : undefined;
  if (node.kind === "image" && node.assetId) {
    return (
      <div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/mulches/${mulchId}/assets/${node.assetId}`} alt={node.text || node.fileName || ""} className="block w-full rounded-t-[inherit]" draggable={false} />
        {(node.title || node.fileName || node.text) && (
          <div className="px-3 py-2">
            <div className="text-ink-2 font-medium truncate">{node.title || node.fileName}</div>
            {node.text && <p className="text-ink-2 mt-0.5 line-clamp-3">{node.text}</p>}
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      {video && <VideoPlayer video={video} poster={node.poster ? `/api/mulches/${mulchId}/assets/${node.poster}` : video.poster} title={node.title} />}
    <div className="px-4 py-3">
      {(style.label || node.url) && (
        <div className="flex items-center gap-1.5 mb-1 text-[12px] text-ink-3">
          {node.kind === "doc" && <FileText size={12} strokeWidth={1.75} />}
          {style.label && <span>{style.label}</span>}
          {node.url && (
            <a href={node.url} target="_blank" rel="noreferrer" className="nodrag truncate hover:text-ink inline-flex items-center gap-1">
              {hostOf(node.url)} <ExternalLink size={10} strokeWidth={1.75} />
            </a>
          )}
          {node.kind === "doc" && node.fileName && <span className="truncate">{node.fileName}</span>}
        </div>
      )}
      {node.title && <div className="font-semibold mb-1 leading-[1.3]">{node.title}</div>}
      <div className="mlch-text overflow-hidden" style={{ maxHeight: `${style.clamp * 1.45}em` }}>
        {style.markdown ? (
          <div className="mlch-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.text}</ReactMarkdown>
          </div>
        ) : (
          <p className="whitespace-pre-wrap">{node.text}</p>
        )}
      </div>
    </div>
    </>
  );
}

function NodeViewImpl({ data, selected }: NodeProps<MulchFlowNode>) {
  const { node, mulchId, fresh } = data;
  const style = KIND_STYLES[node.kind];
  const editing = useCanvasUi((s) => s.editingId === node.id);
  const readOnly = useCanvasUi((s) => s.readOnly);
  const setEditing = useCanvasUi((s) => s.setEditing);
  const setOpen = useCanvasUi((s) => s.setOpen);
  const setViewer = useCanvasUi((s) => s.setViewer);
  const apply = useMulch((s) => s.apply);
  const tilt = style.tilt ? jitter(node.id)(5) : 0;
  const long = node.text.length > 400 || node.kind === "ref" || node.kind === "writeup" || node.kind === "doc" || node.kind === "media" || node.kind === "image" || (node.kind === "link" && !!node.assetId);

  return (
    <div
      className={`mlch-node group relative text-ink ${style.card} ${style.tilt ? "rounded-[3px]" : "rounded-[10px]"} ${outline(node, style.tinted)} ${selected ? "outline-[2.5px] outline-amber outline-offset-2" : ""} ${fresh ? "node-enter" : ""}`}
      style={{ transform: tilt ? `rotate(${tilt}deg)` : undefined }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (node.kind === "ref") {
          if (!readOnly) setOpen(node.id);
        }
        // A made file opens: pages and decks in the viewer, other files in their app.
        else if (node.kind === "artifact" && node.docPath) {
          if (/\.(html|svg)$/.test(node.docPath)) setViewer(node.id);
          else if (!readOnly) openFile(mulchId, node.docPath, "open");
        } else if (node.kind === "image") setOpen(node.id);
        else if (node.kind !== "artifact" && node.kind !== "media" && !readOnly) setEditing(node.id);
      }}
    >
      {editing ? (
        <div className="px-4 py-3">
          <Editor node={node} onDone={() => setEditing(undefined)} />
        </div>
      ) : (
        <Body node={node} mulchId={mulchId} />
      )}
      {long && !editing && (
        <button
          className="nodrag absolute top-2 right-2 p-1 rounded-md text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-paper-2 hover:text-ink"
          onClick={() => setOpen(node.id)}
          title="Open"
          aria-label="Open"
        >
          <Maximize2 size={13} strokeWidth={1.75} />
        </button>
      )}
      {/* Four connection points; the canvas connects in loose mode, so any of them starts or ends a connection. */}
      {SIDES.map(([id, position]) => (
        <Handle key={id} id={id} type="source" position={position} className="mlch-handle" />
      ))}
      {selected && !editing && !readOnly && (
        <>
          {/* Width only (height follows the content): the right edge, and a visible corner handle. */}
          {(["right", "bottom-right"] as const).map((position) => (
            <NodeResizeControl
              key={position}
              position={position}
              variant={position === "right" ? ResizeControlVariant.Line : ResizeControlVariant.Handle}
              resizeDirection="horizontal"
              minWidth={140}
              maxWidth={1400}
              className={position === "right" ? "mlch-resize" : "mlch-resize-corner"}
              onResizeEnd={(_event, params) =>
                apply([{ op: "updateNode", id: node.id, patch: { w: Math.round(params.width), x: Math.round(params.x), userTouched: true } }])
              }
            />
          ))}
        </>
      )}
    </div>
  );
}

export const NodeView = memo(NodeViewImpl);
