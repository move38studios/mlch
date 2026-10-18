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
import { Scribble } from "@/components/brand/Scribble";
import { Square } from "lucide-react";
import type { JobStatus } from "@/lib/mulch/events";
import { elapsed, useNow } from "./JobStatus";
import { useCanvasGestures } from "./gestures";
import { CARDS_TYPE, cardsText, copiedCards, pasteOps, readCopiedCards, type CopiedCards, type PasteAt } from "./clipboard";

const ZOOM_LIMITS = { min: 0.1, max: 2 };
const FIT_PADDING = { top: "60px", left: "40px", right: "40px", bottom: "150px" } as const;

/**
 * Long work in progress, drawn where its result will land: what it is, what
 * it is doing now, how long it has run. Clicks pass through to the canvas,
 * except Stop.
 */
function WorkInProgress({ job }: { job: JobStatus }) {
  const now = useNow(true);
  const jobAction = useMulch((s) => s.jobAction);
  const anchor = job.anchor!;
  return (
    <div
      className="absolute rounded-[10px] border border-dashed border-line-2 bg-chrome/80 px-4 py-3 flex flex-col pointer-events-none"
      style={{ transform: `translate(${anchor.x}px, ${anchor.y}px)`, width: anchor.w, height: anchor.h }}
      data-testid="work-in-progress"
    >
      <div className="flex items-center text-[12px] text-ink-3">
        <span>{job.retry?.kind === "research" ? "research" : "making"}</span>
        <button
          onClick={() => void jobAction("cancel", { jobId: job.id })}
          className="nodrag pointer-events-auto ml-auto -mr-1.5 -mt-1 p-1.5 rounded-md hover:bg-paper-2 hover:text-ink"
          title="Stop"
          aria-label="Stop"
        >
          <Square size={11} strokeWidth={2} />
        </button>
      </div>
      <div className="mt-0.5 text-[13.5px] font-semibold leading-[1.3] line-clamp-2">{job.label}</div>
      <div className="mt-auto flex items-center gap-2 text-[12.5px] text-ink-2">
        <Scribble which="bottom" mode="loop" strokeWidth={11} className="h-3 w-8 shrink-0 text-ink" />
        <span className="truncate">{job.activity ?? "Starting"}</span>
        <span className="ml-auto shrink-0 tabular-nums text-ink-3">{elapsed(job.startedAt, now)}</span>
      </div>
    </div>
  );
}

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
    // While the person resizes a card, its live size and position win over the stored ones.
    const resizing = old?.resizing;
    return {
      id: node.id,
      type: "mulch",
      position: old?.dragging || resizing ? old.position : { x: node.x, y: node.y },
      width: resizing ? old.width : node.w ?? NODE_WIDTH[node.kind],
      ...(resizing ? { height: old.height } : node.fixedH && node.h ? { height: node.h } : {}),
      selected: old?.selected,
      dragging: old?.dragging,
      resizing,
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
  const resizingIds = useRef<Set<string>>(new Set());

  // Pasted or duplicated cards are selected once they are on the canvas.
  const selectAfter = useRef<Set<string>>(undefined);
  useEffect(() => {
    const pick = selectAfter.current && [...selectAfter.current].every((id) => mulch.nodes[id]) ? selectAfter.current : undefined;
    if (pick) selectAfter.current = undefined;
    setNodes((previous) => {
      const next = toFlowNodes(mulch, previous, fresh);
      return pick ? next.map((node) => ({ ...node, selected: pick.has(node.id) })) : next;
    });
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
        if (change.type !== "dimensions") continue;
        // A resize in progress: nothing is written until it ends (onResizeEnd writes the size).
        if (change.resizing !== undefined) {
          if (change.resizing) resizingIds.current.add(change.id);
          else resizingIds.current.delete(change.id);
        }
        if (!change.dimensions || change.resizing || resizingIds.current.has(change.id)) continue;
        if (change.id.startsWith(GROUP_PREFIX)) continue;
        const node = mulch.nodes[change.id];
        if (!node || node.fixedH) continue;
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

  // The note stays even when nothing was typed; it can be written later.
  const commitDraft = useCallback(() => {
    if (draft) {
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

  // A screenshot (see components/desktop/Screenshot.tsx) lands in the middle of the view.
  useEffect(() => {
    if (readOnly) return;
    const onFile = (event: Event) => {
      const file = (event as CustomEvent<File>).detail;
      const at = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      void ingest("files", { x: at.x - 130, y: at.y - 100 }, file);
    };
    window.addEventListener("mlch:add-file", onFile);
    return () => window.removeEventListener("mlch:add-file", onFile);
  }, [flow, ingest, readOnly]);

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

  // The selected cards (and the members of selected groups).
  const selectedCards = useCallback((): CopiedCards | undefined => {
    const picked = flow.getNodes().filter((node) => node.selected);
    const groups = new Set(picked.filter((node) => node.id.startsWith(GROUP_PREFIX)).map((node) => node.id.slice(GROUP_PREFIX.length)));
    const ids = [...picked.filter((node) => !node.id.startsWith(GROUP_PREFIX)).map((node) => node.id), ...Object.values(mulch.nodes).filter((node) => node.groupId && groups.has(node.groupId)).map((node) => node.id)];
    return copiedCards(mulch, ids);
  }, [flow, mulch]);

  const pasteCards = useCallback(
    async (cards: CopiedCards, at: PasteAt) => {
      try {
        const { ops, ids } = await pasteOps(mulchId, cards, at);
        selectAfter.current = new Set(ids);
        apply(ops);
      } catch (error) {
        useMulch.setState({ notice: { level: "error", message: (error as Error).message, at: Date.now() } });
      }
    },
    [apply, mulchId],
  );

  const root = useRef<HTMLDivElement>(null);
  // Where the pointer is over the canvas, for pasting there.
  const pointer = useRef<{ x: number; y: number }>(undefined);

  // Copy the selected cards, unless text is selected or being edited.
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      // Text selected outside the canvas (a side panel, the conversation) is copied as text; on the canvas a selection is a stray from shift-clicking cards.
      const selection = window.getSelection();
      if (selection?.toString() && !(selection.anchorNode && root.current?.contains(selection.anchorNode))) return;
      const cards = selectedCards();
      if (!cards || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", cardsText(cards));
      // A read-only canvas (a shared link) has no files here to copy from: text only.
      if (!readOnly) event.clipboardData.setData(CARDS_TYPE, JSON.stringify(cards));
    };
    window.addEventListener("copy", onCopy);
    return () => window.removeEventListener("copy", onCopy);
  }, [readOnly, selectedCards]);

  // ⌘D: the selected cards again, a little down and right.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (readOnly || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "d") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      const cards = selectedCards();
      if (!cards) return;
      event.preventDefault();
      void pasteCards(cards, { offset: { x: 40, y: 40 } });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pasteCards, readOnly, selectedCards]);

  // Paste onto the canvas (not into a text field): copied cards at the pointer; files, links or text in the middle of the view.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (readOnly) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      const data = event.clipboardData;
      if (!data) return;
      const cards = readCopiedCards(data);
      if (cards?.nodes.length) {
        event.preventDefault();
        // At the pointer; else beside the originals here, or in the middle of the view.
        const view = document.querySelector(".react-flow")?.getBoundingClientRect();
        const middle = flow.screenToFlowPosition({ x: (view?.left ?? 0) + (view?.width ?? 800) / 2, y: (view?.top ?? 0) + (view?.height ?? 600) / 2 });
        void pasteCards(cards, pointer.current ? { center: flow.screenToFlowPosition(pointer.current) } : cards.mulchId === mulchId ? { offset: { x: 40, y: 40 } } : { center: middle });
        return;
      }
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
  }, [flow, ingest, mulchId, pasteCards, readOnly]);

  // Long work shows where its result will land.
  const jobs = useMulch((s) => s.jobs);
  const inProgress = Object.values(jobs).filter((job) => job.state === "running" && job.anchor);

  // Finished results the person hasn't seen: once any of them is in view (and
  // the window is in front), they pulse once and count as seen.
  const jobAction = useMulch((s) => s.jobAction);
  const setPulse = useMulch((s) => s.setPulse);
  const checkSeen = useCallback(() => {
    if (readOnly || document.visibilityState !== "visible" || !document.hasFocus()) return;
    const { x, y, zoom } = flow.getViewport();
    const view = { left: -x / zoom, top: -y / zoom, right: (-x + window.innerWidth) / zoom, bottom: (-y + window.innerHeight) / zoom };
    const nodes = useMulch.getState().mulch?.nodes ?? {};
    for (const job of Object.values(useMulch.getState().jobs)) {
      if (job.state !== "done" || !job.unseen) continue;
      const results = (job.resultIds ?? []).filter((id) => nodes[id]);
      const inView = results.some((id) => {
        const n = nodes[id];
        return n.x < view.right && n.x + (n.w ?? 300) > view.left && n.y < view.bottom && n.y + 120 > view.top;
      });
      if (!inView) continue;
      setPulse(results);
      void jobAction("seen", { ids: [job.id] });
    }
  }, [flow, jobAction, readOnly, setPulse]);
  useEffect(() => {
    // After the view settles (a new mulch fits its view first).
    const timer = setTimeout(checkSeen, 900);
    window.addEventListener("focus", checkSeen);
    document.addEventListener("visibilitychange", checkSeen);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", checkSeen);
      document.removeEventListener("visibilitychange", checkSeen);
    };
  }, [jobs, checkSeen]);

  // Mouse wheel zooms, trackpad pans, zoom keys and the View menu.
  const fitAll = useCallback(() => void flow.fitView({ padding: FIT_PADDING, maxZoom: 1, duration: 400 }), [flow]);
  useCanvasGestures(root, flow, ZOOM_LIMITS, fitAll);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const move = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    const leave = () => {
      pointer.current = undefined;
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", leave);
    return () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
    };
  }, []);

  // The agent moves the view.
  const view = useMulch((s) => s.view);
  useEffect(() => {
    if (!view) return;
    if (view.action === "fit") void flow.fitView({ padding: FIT_PADDING, maxZoom: 1, duration: 600 });
    else if (view.action === "in") void flow.zoomIn({ duration: 400 });
    else void flow.zoomOut({ duration: 400 });
    // Only when a new move arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.at]);

  // New results pulse where they are; the view stays put.
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const pulse = useMulch((s) => s.pulse);
  useEffect(() => {
    if (!pulse) return;
    setHighlighted(new Set(pulse.ids));
    const timer = setTimeout(() => setHighlighted(new Set()), 3500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulse?.at]);

  // Show what the agent or a search result points at.
  const focus = useMulch((s) => s.focus);
  useEffect(() => {
    if (!focus) return;
    // A group stands for the items in it.
    const ids = [...new Set(focus.ids.flatMap((id) => (mulch.groups[id] ? Object.values(mulch.nodes).filter((n) => n.groupId === id).map((n) => n.id) : [id])))].filter((id) => mulch.nodes[id]);
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
      ref={root}
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
      onMoveEnd={checkSeen}
      connectionMode={ConnectionMode.Loose}
      connectionLineStyle={{ stroke: "var(--ink)", strokeWidth: 1.5, strokeDasharray: "4 5", strokeLinecap: "round" }}
      connectionRadius={40}
      zoomOnDoubleClick={false}
      deleteKeyCode={editingId || draft || readOnly ? null : ["Backspace", "Delete"]}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      minZoom={ZOOM_LIMITS.min}
      maxZoom={ZOOM_LIMITS.max}
      // Trackpad scroll pans (a mouse wheel zooms, see gestures.ts); pinch and ⌘-wheel zoom.
      panOnScroll
      // Drag on empty canvas moves it, as does Space-drag; Shift-drag draws a selection box.
      panOnDrag
      selectionKeyCode="Shift"
      fitView
      fitViewOptions={{ padding: { top: "40px", left: "40px", right: "40px", bottom: "150px" }, maxZoom: 1 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="rgba(0,0,0,0.14)" bgColor="var(--paper)" />
      <Controls showInteractive={false} position="bottom-right" />
      {/* Worth it only once the canvas is bigger than the window. */}
      {Object.keys(mulch.nodes).length > 14 && <MiniMap position="bottom-left" pannable zoomable bgColor="#ffffff" maskColor="rgba(252,252,250,0.72)" nodeColor="rgba(0,0,0,0.16)" nodeBorderRadius={6} style={{ width: 150, height: 100 }} />}
      {/* A brand-new canvas: the logo's scribble, faint, until the first card lands. */}
      {Object.keys(mulch.nodes).length === 0 && !draft && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none z-0">
          <Scribble which="bottom" className="w-[min(420px,50%)] text-ink/[0.07]" strokeWidth={7} />
        </div>
      )}
      {inProgress.length > 0 && (
        <ViewportPortal>
          {inProgress.map((job) => (
            <WorkInProgress key={job.id} job={job} />
          ))}
        </ViewportPortal>
      )}
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
              className="w-full min-h-[120px] px-4 py-3 text-[15.5px] leading-[1.4] bg-amber-soft rounded-[3px] shadow-[0_6px_14px_-8px_rgba(0,0,0,0.35)] outline-none resize-none field-sizing-content placeholder:text-ink-3"
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
