"use client";

import { createElement, useEffect, useState } from "react";
import { Loader2, Square } from "lucide-react";
import type { MulchNode } from "@/lib/mulch/types";

/** Image, video, audio or 3D, by type. */
export function mediaKind(node: Pick<MulchNode, "mime" | "fileName" | "assetId">): "image" | "video" | "audio" | "model" | "other" {
  const mime = node.mime ?? "";
  const name = (node.fileName ?? node.assetId ?? "").toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/.test(name)) return "image";
  if (mime.startsWith("video/") || /\.(mp4|webm|mov)$/.test(name)) return "video";
  if (mime.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|flac|aac)$/.test(name)) return "audio";
  if (mime.includes("gltf") || /\.(glb|gltf)$/.test(name)) return "model";
  return "other";
}

let modelViewerLoaded: Promise<unknown> | undefined;

/** <model-viewer> registers itself globally; load it once, on first use. */
function ModelView({ src, interactive }: { src: string; interactive: boolean }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    modelViewerLoaded ??= import("@google/model-viewer");
    void modelViewerLoaded.then(() => setReady(true));
  }, []);
  if (!ready) return <div className="h-full grid place-items-center text-ink-3"><Loader2 size={16} className="animate-spin" /></div>;
  return createElement("model-viewer", {
    src,
    "camera-controls": interactive ? "" : undefined,
    "auto-rotate": "",
    "shadow-intensity": "1",
    "interaction-prompt": "none",
    style: { width: "100%", height: "100%", background: "#f6f4ef" },
  });
}

export function MediaPlayer({ node, mulchId, large = false }: { node: MulchNode; mulchId: string; large?: boolean }) {
  if (!node.assetId) return null;
  const src = `/api/mulches/${mulchId}/assets/${node.assetId}`;
  switch (mediaKind(node)) {
    case "image":
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={src} alt={node.title ?? ""} className="block w-full" draggable={false} />;
    case "video":
      return <video src={src} controls loop playsInline preload="metadata" className="nodrag block w-full bg-black" />;
    case "audio":
      return (
        <div className="px-3 pt-3">
          <audio src={src} controls preload="metadata" className="nodrag w-full" />
        </div>
      );
    case "model":
      return (
        <div className={`nodrag nowheel ${large ? "h-[60vh]" : "h-[220px]"}`}>
          <ModelView src={src} interactive />
        </div>
      );
    default:
      return <div className="px-3 pt-3 text-ink-3">{node.fileName}</div>;
  }
}

function GenerationStatus({ node, mulchId }: { node: MulchNode; mulchId: string }) {
  const gen = node.gen!;
  const [now, setNow] = useState(() => Date.now());
  const active = gen.status === "queued" || gen.status === "running";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const elapsed = Math.max(0, Math.round((now - gen.startedAt) / 1000));
  const stop = () => fetch(`/api/mulches/${mulchId}/generations/${gen.id}/cancel`, { method: "POST" });
  return (
    <div className={`h-[150px] flex flex-col justify-center gap-1.5 px-4 rounded-t-[inherit] ${gen.status === "failed" ? "bg-accent/5" : "bg-paper-2"}`}>
      {active ? (
        <>
          <div className="flex items-center gap-2 text-ink-2 font-medium">
            <Loader2 size={14} className="animate-spin" />
            {gen.status === "queued" ? (gen.position ? `Queued, ${gen.position} ahead` : "Queued") : "Generating"}
            <span className="text-ink-3 tabular-nums font-normal">{elapsed}s</span>
            <span className="flex-1" />
            <button onClick={stop} className="nodrag p-1 rounded hover:bg-line" title="Stop" aria-label="Stop">
              <Square size={11} />
            </button>
          </div>
          {gen.log && <p className="text-ink-3 truncate">{gen.log}</p>}
        </>
      ) : gen.status === "failed" ? (
        <>
          <div className="text-accent font-medium">Failed</div>
          <p className="text-ink-2 line-clamp-4">{gen.error}</p>
        </>
      ) : (
        <div className="text-ink-3">Stopped</div>
      )}
    </div>
  );
}

export function MediaBody({ node, mulchId }: { node: MulchNode; mulchId: string }) {
  const done = !!node.assetId;
  return (
    <div>
      {done ? <MediaPlayer node={node} mulchId={mulchId} /> : node.gen ? <GenerationStatus node={node} mulchId={mulchId} /> : null}
      <div className="px-3 py-2.5">
        {node.title && <div className="font-medium text-ink truncate">{node.title}</div>}
        {node.text && <p className="text-ink-2 mt-0.5 line-clamp-2">{node.text}</p>}
        {node.gen && (
          <div className="mt-1 text-[10.5px] text-ink-3 truncate">
            {node.gen.endpoint}
            {node.gen.cost !== undefined && ` · $${node.gen.cost.toFixed(node.gen.cost < 0.1 ? 3 : 2)}`}
          </div>
        )}
      </div>
    </div>
  );
}
