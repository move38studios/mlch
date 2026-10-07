"use client";

import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type Edge, type EdgeProps, type InternalNode } from "@xyflow/react";

export type NapkinFlowEdge = Edge<{ label?: string; ai: boolean }, "floating">;

/** Where the line from a node's centre towards `toward` leaves the node's box. */
function borderPoint(node: InternalNode, toward: { x: number; y: number }) {
  const w = node.measured.width ?? 0;
  const h = node.measured.height ?? 0;
  const cx = node.internals.positionAbsolute.x + w / 2;
  const cy = node.internals.positionAbsolute.y + h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const scale = Math.min(Math.abs((w / 2 + 6) / (dx || 1e-9)), Math.abs((h / 2 + 6) / (dy || 1e-9)));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function centreOf(node: InternalNode) {
  return {
    x: node.internals.positionAbsolute.x + (node.measured.width ?? 0) / 2,
    y: node.internals.positionAbsolute.y + (node.measured.height ?? 0) / 2,
  };
}

function FloatingEdgeImpl({ id, source, target, data, selected, markerEnd }: EdgeProps<NapkinFlowEdge>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;
  const a = borderPoint(sourceNode, centreOf(targetNode));
  const b = borderPoint(targetNode, centreOf(sourceNode));
  const path = `M ${a.x},${a.y} L ${b.x},${b.y}`;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? "var(--accent)" : "rgba(29,27,23,0.35)",
          strokeWidth: selected ? 1.8 : 1.2,
          strokeDasharray: data?.ai ? "4 4" : undefined,
        }}
      />
      {/* A label that would not fit between the cards shows only when the edge is selected. */}
      {data?.label && (selected || Math.hypot(b.x - a.x, b.y - a.y) > data.label.length * 6.5 + 24) && (
        <EdgeLabelRenderer>
          <div
            className="absolute pointer-events-none text-[11px] text-ink-2 bg-paper/90 px-1.5 py-0.5 rounded"
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const FloatingEdge = memo(FloatingEdgeImpl);
