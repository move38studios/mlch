"use client";

import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type Edge, type EdgeProps, type InternalNode } from "@xyflow/react";

export type MulchFlowEdge = Edge<{ label?: string; ai: boolean }, "floating">;

/** Where the line from a card's centre towards `toward` leaves the card, with a small gap. */
function borderPoint(node: InternalNode, toward: { x: number; y: number }) {
  const w = node.measured.width ?? 0;
  const h = node.measured.height ?? 0;
  const cx = node.internals.positionAbsolute.x + w / 2;
  const cy = node.internals.positionAbsolute.y + h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const scale = Math.min(Math.abs((w / 2 + 7) / (dx || 1e-9)), Math.abs((h / 2 + 7) / (dy || 1e-9)));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function centreOf(node: InternalNode) {
  return {
    x: node.internals.positionAbsolute.x + (node.measured.width ?? 0) / 2,
    y: node.internals.positionAbsolute.y + (node.measured.height ?? 0) / 2,
  };
}

/** Each connection bows to one side, always the same side for the same edge. */
function bowSign(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return h & 1 ? 1 : -1;
}

/**
 * A soft curve between two cards: a cubic that bows gently to one side, as a
 * hand would draw it. The person's connections are solid; the AI's are dotted.
 */
function FloatingEdgeImpl({ id, source, target, data, selected }: EdgeProps<MulchFlowEdge>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;
  const a = borderPoint(sourceNode, centreOf(targetNode));
  const b = borderPoint(targetNode, centreOf(sourceNode));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  // Perpendicular offset: about a tenth of the length, capped so long lines stay calm.
  const bow = Math.min(60, length * 0.12) * bowSign(id);
  const nx = (-dy / length) * bow;
  const ny = (dx / length) * bow;
  const c1 = { x: a.x + dx * 0.3 + nx, y: a.y + dy * 0.3 + ny };
  const c2 = { x: a.x + dx * 0.7 + nx, y: a.y + dy * 0.7 + ny };
  const path = `M ${a.x},${a.y} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`;
  // The curve's midpoint (t = 0.5), for the label.
  const mid = { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 };
  const ai = !!data?.ai;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={16}
        style={{
          stroke: selected ? "var(--amber)" : ai ? "rgba(0,0,0,0.42)" : "rgba(0,0,0,0.55)",
          strokeWidth: selected ? 2.5 : ai ? 1.75 : 1.5,
          strokeDasharray: ai && !selected ? "0.1 5" : undefined,
          strokeLinecap: "round",
          fill: "none",
        }}
      />
      {/* A label that would not fit between the cards shows only when the edge is selected. */}
      {data?.label && (selected || length > data.label.length * 6.5 + 28) && (
        <EdgeLabelRenderer>
          <div
            className="absolute pointer-events-none text-[11.5px] leading-none text-ink-2 bg-paper px-2 py-1 rounded-full border border-line"
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
