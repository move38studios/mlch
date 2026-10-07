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
import { newClientId } from "@/lib/mulch/ids";
import { useMulch } from "@/lib/mulch/client";
import { applyOps } from "@/lib/mulch/ops";
import { fittedGroupBox } from "@/lib/mulch/place";
import { NODE_WIDTH } from "@/lib/mulch/sizes";
import type { Mulch, MulchOp } from "@/lib/mulch/types";
import { FloatingEdge, type MulchFlowEdge } from "./FloatingEdge";
import { GroupView, type GroupFlowNode } from "./GroupView";
import { NodeView, type MulchFlowNode } from "./NodeView";
import { useCanvasUi } from "./ui";

type FlowNode = MulchFlowNode | GroupFlowNode;

const nodeTypes = { mulch: NodeView, mulchGroup: GroupView };
const edgeTypes = { floating: FloatingEdge };
const GROUP_PREFIX = "group:";
/** How long a node added by the AI keeps its entrance class. */
const FRESH_MS = 1200;

function toFlowNodes(mulch: Mulch, previous: FlowNode[], fresh: Record<string, number>): FlowNode[] {
  const prev = new Map(previous.map((node) => [node.id, node]));
  const now = Date.now();
  const groups: FlowNode[] = Object.values(mulch.groups).map((group) => {
    const id = GROUP_PREFIX + group.id;
    const old = prev.get(id);
    return {
      id,
      type: "mulchGroup",
      position: old?.dragging ? old.position : { x: group.x, y: group.y },
      width: group.w,
      height: group.h,
      zIndex: -1,
      selected: old?.selected,
      dragging: old?.dragging,
      data: { group },
    };
  });
  const nodes: FlowNode[] = Object.values(mulch.nodes).map((node) => {
    const old = prev.get(node.id);
    return {
      id: node.id,
      type: "mulch",
      position: old?.dragging ? old.position : { x: node.x, y: node.y },
      width: node.w ?? NODE_WIDTH[node.kind],
      selected: old?.selected,
      dragging: old?.dragging,
      measured: old?.measured,
      data: { node, mulchId: mulch.id, fresh: !!fresh[node.id] && now - fresh[node.id] < FRESH_MS },
    };
  });
  return [...groups, ...nodes];
}

/** updateGroup ops that refit these groups (not ones the person moved) around their members. */
function groupFits(mulch: Mulch, groupIds: Iterable<string>): MulchOp[] {
  const ops: MulchOp[] = [];
  for (const groupId of groupIds) {
    if (!mulch.groups[groupId] || mulch.groups[groupId].userTouched) continue;
    const box = fittedGroupBox(mulch, groupId);
    if (box) ops.push({ op: "updateGroup", id: groupId, patch: box });
  }
  return ops;
}

function toFlowEdges(mulch: Mulch, selected: Set<string>): MulchFlowEdge[] {
  return Object.values(mulch.edges).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "floating",
    selected: selected.has(edge.id),
    data: { label: edge.label, ai: edge.origin !== "user" },
  }));
}

function CanvasInner({ mulch }: { mulch: Mulch }) {
  const apply = useMulch((s) => s.apply);
  const undo = useMulch((s) => s.undo);
  const redo = useMulch((s) => s.redo);
  const fresh = useMulch((s) => s.fresh);
  const editingId = useCanvasUi((s) => s.editingId);
  const readOnly = useCanvasUi((s) => s.readOnly);
  const setEditing = useCanvasUi((s) => s.setEditing);
  const flow = useReactFlow<FlowNode, Edge>();
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<{ x: number; y: number; text: string }>();
  const dragStart = useRef<Map<string, { x: number; y: number }>>(new Map());

  useEffect(() => {
    setNodes((previous) => toFlowNodes(mulch, previous, fresh));
  }, [mulch, fresh]);

  // Clear the entrance class after it has played.
  useEffect(() => {
    const ids = Object.keys(fresh);
    if (!ids.length) return;
    const timer = setTimeout(() => setNodes((previous) => toFlowNodes(mulch, previous, fresh)), FRESH_MS + 50);
    return () => clearTimeout(timer);
  }, [fresh, mulch]);

  const edges = useMemo(() => toFlowEdges(mulch, selectedEdges), [mulch, selectedEdges]);

  // Measured sizes go back to the mulch so placement uses real boxes.
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
      const sizes: MulchOp[] = [];
      const touchedGroups = new Set<string>();
      for (const change of changes) {
        if (change.type !== "dimensions" || !change.dimensions || change.resizing) continue;
        if (change.id.startsWith(GROUP_PREFIX)) continue;
        const node = mulch.nodes[change.id];
        if (!node) continue;
        if (node.groupId) touchedGroups.add(node.groupId);
        const h = Math.round(change.dimensions.height);
        if (h > 0 && Math.abs((node.h ?? 0) - h) > 2) sizes.push({ op: "updateNode", id: node.id, patch: { h } });
      }
      // Groups the AI laid out follow their members' real sizes.
      const fits = groupFits(applyOps(mulch, sizes), touchedGroups);
      if (sizes.length || fits.length) apply([...sizes, ...fits], { undoable: false });
    },
    [apply, mulch],
  );

  const onNodeDragStart = useCallback(
    (_event: unknown, _node: FlowNode, dragged: FlowNode[]) => {
      dragStart.current = new Map();
      for (const node of dragged) {
        dragStart.current.set(node.id, { ...node.position });
        // Dragging a group drags its members.
        if (node.id.startsWith(GROUP_PREFIX)) {
          const groupId = node.id.slice(GROUP_PREFIX.length);
          for (const member of Object.values(mulch.nodes)) {
            if (member.groupId === groupId) dragStart.current.set(member.id, { x: member.x, y: member.y });
          }
        }
      }
    },
    [mulch],
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
          if (node.type === "mulch" && (node as MulchFlowNode).data.node.groupId === groupId) offsets.set(node.id, { dx, dy });
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
      const ops: MulchOp[] = [];
      for (const [id, start] of dragStart.current) {
        const node = current.get(id);
        if (!node) continue;
        const x = Math.round(node.position.x);
        const y = Math.round(node.position.y);
        if (x === Math.round(start.x) && y === Math.round(start.y)) continue;
        if (id.startsWith(GROUP_PREFIX)) ops.push({ op: "updateGroup", id: id.slice(GROUP_PREFIX.length), patch: { x, y, userTouched: true } });
        else {
          const patch: Extract<MulchOp, { op: "updateNode" }>["patch"] = { x, y, userTouched: true };
          // A node dragged on its own out of its group's box leaves the group.
          const member = mulch.nodes[id];
          const group = member?.groupId ? mulch.groups[member.groupId] : undefined;
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
      // Members moved inside (or out of) an AI-laid-out group: refit it.
      const after = applyOps(mulch, ops);
      const groups = new Set<string>();
      for (const op of ops) {
        if (op.op !== "updateNode") continue;
        const before = mulch.nodes[op.id]?.groupId;
        if (before) groups.add(before);
      }
      apply([...ops, ...groupFits(after, groups)]);
    },
    [apply, flow, mulch],
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
      const ops: MulchOp[] = [
        ...edges.map((edge): MulchOp => ({ op: "removeEdge", id: edge.id })),
        ...nodes.map((node): MulchOp =>
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
      if (readOnly) return;
      const target = event.target as HTMLElement;
      if (!target.classList.contains("react-flow__pane")) return;
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setDraft({ x: position.x - 20, y: position.y - 16, text: "" });
    },
    [flow, readOnly],
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

  // Files, links and text dropped or pasted onto the canvas.
  const mulchId = mulch.id;
  const ingest = useCallback(
    async (kind: "files" | "links" | "paste", at: { x: number; y: number }, payload: File | string) => {
      try {
        const response =
          kind === "files"
            ? await fetch(`/api/mulches/${mulchId}/files?name=${encodeURIComponent((payload as File).name)}&x=${Math.round(at.x)}&y=${Math.round(at.y)}`, {
                method: "POST",
                body: payload as File,
              })
            : await fetch(`/api/mulches/${mulchId}/${kind}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...(kind === "links" ? { url: payload } : { text: payload }), x: at.x, y: at.y }),
              });
        if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || `Failed (${response.status})`);
      } catch (error) {
        useMulch.setState({ notice: { level: "error", message: (error as Error).message, at: Date.now() } });
      }
    },
    [mulchId],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const files = Array.from(event.dataTransfer.files);
      if (files.length) {
        files.forEach((file, i) => void ingest("files", { x: at.x + i * 40, y: at.y + i * 40 }, file));
        return;
      }
      const uri = event.dataTransfer.getData("text/uri-list").split("\n").find((line) => line && !line.startsWith("#"));
      const text = uri || event.dataTransfer.getData("text/plain");
      if (!text.trim()) return;
      void ingest(/^https?:\/\/\S+$/.test(text.trim()) ? "links" : "paste", at, text.trim());
    },
    [flow, ingest],
  );

  // Paste onto the canvas (not into a text field): files, links or text land in the middle of the view.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (readOnly) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      const data = event.clipboardData;
      if (!data) return;
      const rect = document.querySelector(".react-flow")?.getBoundingClientRect();
      const at = flow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2 });
      const files = Array.from(data.files);
      if (files.length) {
        event.preventDefault();
        files.forEach((file, i) => void ingest("files", { x: at.x + i * 40, y: at.y + i * 40 }, file.name ? file : new File([file], `pasted.${file.type.split("/")[1] || "bin"}`)));
        return;
      }
      const text = data.getData("text/plain").trim();
      if (!text) return;
      event.preventDefault();
      void ingest(/^https?:\/\/\S+$/.test(text) ? "links" : "paste", at, text);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [flow, ingest, readOnly]);

  // Show what the agent or a search result points at.
  const focus = useMulch((s) => s.focus);
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!focus) return;
    const ids = focus.ids.filter((id) => mulch.nodes[id]);
    if (!ids.length) return;
    void flow.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.35, maxZoom: 1.1, duration: 600 });
    setNodes((current) => current.map((node) => ({ ...node, selected: ids.includes(node.id) })));
    setHighlighted(new Set(ids));
    const one = ids.length === 1 ? mulch.nodes[ids[0]] : undefined;
    if (one && (focus.page || focus.quote || ["doc", "link", "writeup"].includes(one.kind))) {
      useCanvasUi.getState().setHighlight({ quote: focus.quote, page: focus.page });
      useCanvasUi.getState().setOpen(one.id);
    }
    const timer = setTimeout(() => setHighlighted(new Set()), 3500);
    return () => clearTimeout(timer);
    // Only when a new focus arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.at]);

  // Undo / redo, unless typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (readOnly) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, readOnly]);

  const shownNodes = useMemo(
    () => (highlighted.size ? nodes.map((node) => (highlighted.has(node.id) ? { ...node, className: "mlch-focused" } : node)) : nodes),
    [nodes, highlighted],
  );

  return (
    <ReactFlow<FlowNode, Edge>
      nodes={shownNodes}
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
      onDrop={readOnly ? undefined : onDrop}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onPaneClick={() => setEditing(undefined)}
      connectionMode={ConnectionMode.Loose}
      connectionRadius={40}
      zoomOnDoubleClick={false}
      deleteKeyCode={editingId || draft || readOnly ? null : ["Backspace", "Delete"]}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      minZoom={0.1}
      maxZoom={2}
      panOnScroll
      selectionOnDrag
      panOnDrag={[1, 2]}
      fitView
      fitViewOptions={{ padding: { top: "40px", left: "40px", right: "40px", bottom: "150px" }, maxZoom: 1 }}
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

export function Canvas({ mulch }: { mulch: Mulch }) {
  return (
    <ReactFlowProvider>
      <CanvasInner mulch={mulch} />
    </ReactFlowProvider>
  );
}
