"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  ViewportPortal,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { newClientId } from "@/lib/napkin/ids";
import { useNapkin } from "@/lib/napkin/client";
import { NODE_WIDTH } from "@/lib/napkin/sizes";
import type { Napkin, NapkinOp } from "@/lib/napkin/types";
import { FloatingEdge, type NapkinFlowEdge } from "./FloatingEdge";
import { GroupView, type GroupFlowNode } from "./GroupView";
import { NodeView, type NapkinFlowNode } from "./NodeView";
import { useCanvasUi } from "./ui";

type FlowNode = NapkinFlowNode | GroupFlowNode;

const nodeTypes = { napkin: NodeView, napkinGroup: GroupView };
const edgeTypes = { floating: FloatingEdge };
const GROUP_PREFIX = "group:";
/** How long a node added by the AI keeps its entrance class. */
const FRESH_MS = 1200;

function toFlowNodes(napkin: Napkin, previous: FlowNode[], fresh: Record<string, number>): FlowNode[] {
  const prev = new Map(previous.map((node) => [node.id, node]));
  const now = Date.now();
  const groups: FlowNode[] = Object.values(napkin.groups).map((group) => {
    const id = GROUP_PREFIX + group.id;
    const old = prev.get(id);
    return {
      id,
      type: "napkinGroup",
      position: old?.dragging ? old.position : { x: group.x, y: group.y },
      width: group.w,
      height: group.h,
      zIndex: -1,
      selected: old?.selected,
      dragging: old?.dragging,
      data: { group },
    };
  });
  const nodes: FlowNode[] = Object.values(napkin.nodes).map((node) => {
    const old = prev.get(node.id);
    return {
      id: node.id,
      type: "napkin",
      position: old?.dragging ? old.position : { x: node.x, y: node.y },
      width: node.w ?? NODE_WIDTH[node.kind],
      selected: old?.selected,
      dragging: old?.dragging,
      measured: old?.measured,
      data: { node, napkinId: napkin.id, fresh: !!fresh[node.id] && now - fresh[node.id] < FRESH_MS },
    };
  });
  return [...groups, ...nodes];
}

function toFlowEdges(napkin: Napkin, selected: Set<string>): NapkinFlowEdge[] {
  return Object.values(napkin.edges).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "floating",
    selected: selected.has(edge.id),
    data: { label: edge.label, ai: edge.origin !== "user" },
  }));
}

function CanvasInner({ napkin }: { napkin: Napkin }) {
  const apply = useNapkin((s) => s.apply);
  const undo = useNapkin((s) => s.undo);
  const redo = useNapkin((s) => s.redo);
  const fresh = useNapkin((s) => s.fresh);
  const editingId = useCanvasUi((s) => s.editingId);
  const setEditing = useCanvasUi((s) => s.setEditing);
  const flow = useReactFlow<FlowNode, Edge>();
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<{ x: number; y: number; text: string }>();
  const dragStart = useRef<Map<string, { x: number; y: number }>>(new Map());

  useEffect(() => {
    setNodes((previous) => toFlowNodes(napkin, previous, fresh));
  }, [napkin, fresh]);

  // Clear the entrance class after it has played.
  useEffect(() => {
    const ids = Object.keys(fresh);
    if (!ids.length) return;
    const timer = setTimeout(() => setNodes((previous) => toFlowNodes(napkin, previous, fresh)), FRESH_MS + 50);
    return () => clearTimeout(timer);
  }, [fresh, napkin]);

  const edges = useMemo(() => toFlowEdges(napkin, selectedEdges), [napkin, selectedEdges]);

  // Measured sizes go back to the napkin so placement uses real boxes.
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
      const sizes: NapkinOp[] = [];
      for (const change of changes) {
        if (change.type !== "dimensions" || !change.dimensions || change.resizing) continue;
        if (change.id.startsWith(GROUP_PREFIX)) continue;
        const node = napkin.nodes[change.id];
        if (!node) continue;
        const h = Math.round(change.dimensions.height);
        if (h > 0 && Math.abs((node.h ?? 0) - h) > 2) sizes.push({ op: "updateNode", id: node.id, patch: { h } });
      }
      if (sizes.length) apply(sizes, { undoable: false });
    },
    [apply, napkin],
  );

  const onNodeDragStart = useCallback(
    (_event: unknown, _node: FlowNode, dragged: FlowNode[]) => {
      dragStart.current = new Map();
      for (const node of dragged) {
        dragStart.current.set(node.id, { ...node.position });
        // Dragging a group drags its members.
        if (node.id.startsWith(GROUP_PREFIX)) {
          const groupId = node.id.slice(GROUP_PREFIX.length);
          for (const member of Object.values(napkin.nodes)) {
            if (member.groupId === groupId) dragStart.current.set(member.id, { x: member.x, y: member.y });
          }
        }
      }
    },
    [napkin],
  );

  const onNodeDrag = useCallback((_event: unknown, _node: FlowNode, dragged: FlowNode[]) => {
    const groups = dragged.filter((node) => node.id.startsWith(GROUP_PREFIX));
    if (!groups.length) return;
    setNodes((current) => {
      const offsets = new Map<string, { dx: number; dy: number }>();
      for (const group of groups) {
        const start = dragStart.current.get(group.id);
        if (!start) continue;
        const groupId = group.id.slice(GROUP_PREFIX.length);
        const dx = group.position.x - start.x;
        const dy = group.position.y - start.y;
        for (const node of current) {
          if (node.type === "napkin" && (node as NapkinFlowNode).data.node.groupId === groupId) offsets.set(node.id, { dx, dy });
        }
      }
      return current.map((node) => {
        const offset = offsets.get(node.id);
        const start = dragStart.current.get(node.id);
        if (!offset || !start || dragged.some((d) => d.id === node.id)) return node;
        return { ...node, position: { x: start.x + offset.dx, y: start.y + offset.dy } };
      });
    });
  }, []);

  const onNodeDragStop = useCallback(
    (_event: unknown, _node: FlowNode, dragged: FlowNode[]) => {
      const current = new Map(flow.getNodes().map((node) => [node.id, node]));
      const ops: NapkinOp[] = [];
      for (const [id, start] of dragStart.current) {
        const node = current.get(id);
        if (!node) continue;
        const x = Math.round(node.position.x);
        const y = Math.round(node.position.y);
        if (x === Math.round(start.x) && y === Math.round(start.y)) continue;
        if (id.startsWith(GROUP_PREFIX)) ops.push({ op: "updateGroup", id: id.slice(GROUP_PREFIX.length), patch: { x, y, userTouched: true } });
        else {
          const patch: Extract<NapkinOp, { op: "updateNode" }>["patch"] = { x, y, userTouched: true };
          // A node dragged on its own out of its group's box leaves the group.
          const member = napkin.nodes[id];
          const group = member?.groupId ? napkin.groups[member.groupId] : undefined;
          if (group && dragged.some((d) => d.id === id) && !dragged.some((d) => d.id === GROUP_PREFIX + group.id)) {
            const w = member.w ?? NODE_WIDTH[member.kind];
            const cx = x + w / 2;
            const cy = y + (member.h ?? 80) / 2;
            if (cx < group.x || cx > group.x + group.w || cy < group.y || cy > group.y + group.h) patch.groupId = null;
          }
          ops.push({ op: "updateNode", id, patch });
        }
      }
      dragStart.current = new Map();
      apply(ops);
    },
    [apply, flow, napkin],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      if (connection.source.startsWith(GROUP_PREFIX) || connection.target.startsWith(GROUP_PREFIX)) return;
      apply([
        {
          op: "addEdge",
          edge: { id: newClientId("e"), source: connection.source, target: connection.target, origin: "user", createdAt: Date.now() },
        },
      ]);
    },
    [apply],
  );

  // A connection dropped anywhere on a card (not just on its handle) connects to it.
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      const target = document
        .elementsFromPoint(point.clientX, point.clientY)
        .map((element) => element.closest<HTMLElement>(".react-flow__node"))
        .find((element) => element && element.dataset.id !== state.fromNode?.id);
      const targetId = target?.dataset.id;
      if (targetId) onConnect({ source: state.fromNode.id, target: targetId, sourceHandle: null, targetHandle: null });
    },
    [onConnect],
  );

  const onSelectionChange = useCallback(({ edges }: OnSelectionChangeParams) => {
    setSelectedEdges(new Set(edges.map((edge) => edge.id)));
  }, []);

  const onDelete = useCallback(
    ({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
      const ops: NapkinOp[] = [
        ...edges.map((edge): NapkinOp => ({ op: "removeEdge", id: edge.id })),
        ...nodes.map((node): NapkinOp =>
          node.id.startsWith(GROUP_PREFIX) ? { op: "removeGroup", id: node.id.slice(GROUP_PREFIX.length) } : { op: "removeNode", id: node.id },
        ),
      ];
      apply(ops);
    },
    [apply],
  );

  // Double-click empty canvas: type a note there.
  const onPaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.classList.contains("react-flow__pane")) return;
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setDraft({ x: position.x - 20, y: position.y - 16, text: "" });
    },
    [flow],
  );

  const commitDraft = useCallback(() => {
    if (draft?.text.trim()) {
      apply([
        {
          op: "addNode",
          node: { id: newClientId("n"), kind: "note", x: Math.round(draft.x), y: Math.round(draft.y), text: draft.text.trim(), origin: "user", userTouched: true, createdAt: Date.now() },
        },
      ]);
    }
    setDraft(undefined);
  }, [apply, draft]);

  // Undo / redo, unless typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  return (
    <ReactFlow<FlowNode, Edge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onConnectEnd={onConnectEnd}
      onDelete={onDelete}
      onSelectionChange={onSelectionChange}
      onDoubleClick={onPaneDoubleClick}
      onPaneClick={() => setEditing(undefined)}
      connectionMode={ConnectionMode.Loose}
      connectionRadius={40}
      zoomOnDoubleClick={false}
      deleteKeyCode={editingId || draft ? null : ["Backspace", "Delete"]}
      minZoom={0.1}
      maxZoom={2}
      panOnScroll
      selectionOnDrag
      panOnDrag={[1, 2]}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#d4cfc4" />
      <Controls showInteractive={false} position="bottom-right" />
      <MiniMap position="bottom-left" pannable zoomable maskColor="rgba(246,244,239,0.7)" nodeColor="#cfc9bc" style={{ width: 160, height: 110 }} />
      {draft && (
        <ViewportPortal>
          <div className="absolute" style={{ transform: `translate(${draft.x}px, ${draft.y}px)`, width: NODE_WIDTH.note }}>
            <textarea
              autoFocus
              value={draft.text}
              placeholder="Type"
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) commitDraft();
              }}
              className="w-full px-3.5 py-3 text-[15px] leading-snug bg-white/80 border border-line rounded-[6px] outline-none resize-none field-sizing-content"
            />
          </div>
        </ViewportPortal>
      )}
    </ReactFlow>
  );
}

export function Canvas({ napkin }: { napkin: Napkin }) {
  return (
    <ReactFlowProvider>
      <CanvasInner napkin={napkin} />
    </ReactFlowProvider>
  );
}
