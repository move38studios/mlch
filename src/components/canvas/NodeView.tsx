"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Handle, NodeResizeControl, Position, ResizeControlVariant, type NodeProps, type Node } from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink, FileText, Maximize2 } from "lucide-react";
import { useNapkin } from "@/lib/napkin/client";
import { jitter } from "@/lib/napkin/place";
import type { NapkinNode } from "@/lib/napkin/types";
import { KIND_STYLES } from "./kinds";
import { useCanvasUi } from "./ui";

export type NapkinFlowNode = Node<{ node: NapkinNode; napkinId: string; fresh: boolean }, "napkin">;

/** Added by the AI rather than said, typed or dropped by the user, and not since edited. */
function isAiMade(node: NapkinNode): boolean {
  return node.origin.startsWith("agent:") && !node.userTouched;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Editor({ node, onDone }: { node: NapkinNode; onDone: () => void }) {
  const apply = useNapkin((s) => s.apply);
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

function Body({ node, napkinId }: { node: NapkinNode; napkinId: string }) {
  const style = KIND_STYLES[node.kind];
  if (node.kind === "image" && node.assetId) {
    return (
      <div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/napkins/${napkinId}/assets/${node.assetId}`} alt={node.text || node.fileName || ""} className="block w-full rounded-t-[inherit]" draggable={false} />
        {(node.title || node.fileName) && <div className="px-3 py-2 text-ink-2 truncate">{node.title || node.fileName}</div>}
      </div>
    );
  }
  return (
    <div className="px-3.5 py-3">
      {(style.label || node.url) && (
        <div className="flex items-center gap-1.5 mb-1.5 text-[10.5px] uppercase tracking-wider text-ink-3 font-medium">
          {node.kind === "doc" && <FileText size={11} />}
          {style.label && <span>{style.label}</span>}
          {node.url && (
            <a href={node.url} target="_blank" rel="noreferrer" className="nodrag normal-case tracking-normal truncate hover:text-ink-2 inline-flex items-center gap-1">
              {hostOf(node.url)} <ExternalLink size={10} />
            </a>
          )}
          {node.kind === "doc" && node.fileName && <span className="normal-case tracking-normal truncate">{node.fileName}</span>}
        </div>
      )}
      {node.title && <div className="font-semibold mb-1 leading-snug">{node.title}</div>}
      <div className="napkin-text overflow-hidden" style={{ maxHeight: `${style.clamp * 1.45}em` }}>
        {style.markdown ? (
          <div className="napkin-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.text}</ReactMarkdown>
          </div>
        ) : (
          <p className="whitespace-pre-wrap">{node.text}</p>
        )}
      </div>
    </div>
  );
}

function NodeViewImpl({ data, selected }: NodeProps<NapkinFlowNode>) {
  const { node, napkinId, fresh } = data;
  const style = KIND_STYLES[node.kind];
  const editing = useCanvasUi((s) => s.editingId === node.id);
  const setEditing = useCanvasUi((s) => s.setEditing);
  const setOpen = useCanvasUi((s) => s.setOpen);
  const apply = useNapkin((s) => s.apply);
  const tilt = style.tilt ? jitter(node.id)(5) : 0;
  const long = node.text.length > 400 || node.kind === "writeup" || node.kind === "doc" || (node.kind === "link" && !!node.assetId);

  return (
    <div
      className={`napkin-node group relative rounded-[6px] text-ink ${style.card} ${selected ? "ring-2 ring-accent/70" : ""} ${fresh ? "node-enter" : ""} ${isAiMade(node) ? "napkin-ai" : ""}`}
      style={{ transform: tilt ? `rotate(${tilt}deg)` : undefined }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (node.kind !== "image") setEditing(node.id);
      }}
    >
      <Handle type="target" position={Position.Left} className="napkin-handle-target" isConnectableStart={false} />
      {editing ? (
        <div className="px-3.5 py-3">
          <Editor node={node} onDone={() => setEditing(undefined)} />
        </div>
      ) : (
        <Body node={node} napkinId={napkinId} />
      )}
      {long && !editing && (
        <button
          className="nodrag absolute top-1.5 right-1.5 p-1 rounded text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-paper-2 hover:text-ink"
          onClick={() => setOpen(node.id)}
          title="Open"
          aria-label="Open"
        >
          <Maximize2 size={12} />
        </button>
      )}
      <Handle type="source" position={Position.Right} className="napkin-handle" />
      {selected && !editing && (
        <NodeResizeControl
          position="right"
          variant={ResizeControlVariant.Line}
          resizeDirection="horizontal"
          minWidth={140}
          maxWidth={900}
          className="napkin-resize"
          onResizeEnd={(_event, params) =>
            apply([{ op: "updateNode", id: node.id, patch: { w: Math.round(params.width), x: Math.round(params.x), userTouched: true } }])
          }
        />
      )}
    </div>
  );
}

export const NodeView = memo(NodeViewImpl);
