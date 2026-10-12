/**
 * A shared canvas, read-only, in the browser. It uses the app's own card,
 * group and connection components, so a shared canvas looks like the one in
 * the app; the share host serves the share's files where those components
 * look for them (/api/mulches/<share id>/…).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyNodeChanges, Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow } from "@xyflow/react";
import { useCanvasGestures } from "@/components/canvas/gestures";
import { useMulch } from "@/lib/mulch/client";
import { NODE_WIDTH } from "@/lib/mulch/sizes";
import type { Mulch, OpBatch } from "@/lib/mulch/types";
import { ArtifactViewer } from "@/components/canvas/ArtifactViewer";
import { FloatingEdge, type MulchFlowEdge } from "@/components/canvas/FloatingEdge";
import { GroupView, type GroupFlowNode } from "@/components/canvas/GroupView";
import { NodeView, type MulchFlowNode } from "@/components/canvas/NodeView";
import { SidePanel } from "@/components/canvas/SidePanel";
import { useCanvasUi } from "@/components/canvas/ui";
import { emptyFeed, withBatch, withSnapshot, type Feed } from "./live";

type FlowNode = MulchFlowNode | GroupFlowNode;
const nodeTypes = { mulch: NodeView, mulchGroup: GroupView };
const edgeTypes = { floating: FloatingEdge };
const FRESH_MS = 1200;

export const shareId = location.pathname.match(/^\/s\/([A-Za-z0-9]+)/)?.[1] ?? "";

type Status = "loading" | "ready" | "missing";

type Message =
  | { type: "hello"; title: string; live: boolean; seq: number; snapshotSeq: number }
  | { type: "ops"; seq: number; batch: OpBatch }
  | { type: "snapshot"; seq: number }
  | { type: "live"; live: boolean }
  | { type: "deleted" };

async function fetchSnapshot(): Promise<{ mulch: Mulch; seq: number } | undefined> {
  const response = await fetch(`/s/${shareId}/snapshot.json`, { cache: "no-store" });
  if (!response.ok) return undefined;
  return { mulch: (await response.json()) as Mulch, seq: Number(response.headers.get("X-Mlch-Seq") ?? 0) };
}

/** Follows the room: snapshot, then batches; reconnects with backoff. */
function useShare() {
  const [status, setStatus] = useState<Status>("loading");
  const [live, setLive] = useState(false);
  const feed = useRef<Feed>(emptyFeed);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const show = (next: Feed, added: string[]) => {
      feed.current = next;
      if (!next.mulch) return;
      const fresh = { ...useMulch.getState().fresh };
      for (const id of added) fresh[id] = Date.now();
      useMulch.setState({ id: shareId, mulch: next.mulch, fresh, connected: true });
      setStatus("ready");
    };

    const refetch = async () => {
      const snapshot = await fetchSnapshot();
      if (!snapshot) {
        if (!feed.current.mulch) setStatus("missing");
        return;
      }
      const result = withSnapshot(feed.current, snapshot.mulch, snapshot.seq);
      show(result.feed, []);
      if (result.gap) socket?.close(); // fell behind: start over
    };

    const connect = () => {
      socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/s/${shareId}/live`);
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Message;
        if (message.type === "hello") {
          retry = 0;
          setLive(message.live);
          feed.current = { ...feed.current, pending: [] };
          void refetch();
        } else if (message.type === "ops") {
          const result = withBatch(feed.current, message.seq, message.batch);
          show(result.feed, result.added);
          if (result.gap) void refetch();
        } else if (message.type === "snapshot") {
          feed.current = { ...feed.current, seq: Math.min(feed.current.seq, message.seq - 1) };
          void refetch();
        } else if (message.type === "live") {
          setLive(message.live);
        } else if (message.type === "deleted") {
          closed = true;
          useMulch.setState({ mulch: undefined });
          setStatus("missing");
        }
      };
      socket.onclose = () => {
        setLive(false);
        if (closed) return;
        // The share may not exist, or the network dropped: show what's there and try again.
        if (!feed.current.mulch) void refetch();
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
      };
    };

    useCanvasUi.setState({ readOnly: true });
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return { status, live };
}

function toFlowNodes(mulch: Mulch, fresh: Record<string, number>, previous: Map<string, FlowNode>): FlowNode[] {
  const now = Date.now();
  const groups: FlowNode[] = Object.values(mulch.groups).map((group) => ({
    id: `group:${group.id}`,
    type: "mulchGroup",
    position: { x: group.x, y: group.y },
    width: group.w,
    height: group.h,
    zIndex: -1,
    draggable: false,
    selectable: false,
    data: { group },
  }));
  const nodes: FlowNode[] = Object.values(mulch.nodes).map((node) => ({
    id: node.id,
    type: "mulch",
    position: { x: node.x, y: node.y },
    width: node.w ?? NODE_WIDTH[node.kind],
    measured: previous.get(node.id)?.measured,
    draggable: false,
    data: { node, mulchId: shareId, fresh: !!fresh[node.id] && now - fresh[node.id] < FRESH_MS },
  }));
  return [...groups, ...nodes];
}

const ZOOM = { min: 0.1, max: 2 };

function Board() {
  const mulch = useMulch((s) => s.mulch);
  const fresh = useMulch((s) => s.fresh);
  const flow = useReactFlow();
  const initialized = useNodesInitialized();
  const fitted = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  // As in the app: a mouse wheel zooms at the pointer, a trackpad pans, pinch zooms; ⌘+ ⌘− ⌘0.
  const fit = useCallback(() => void flow.fitView({ padding: 0.12, maxZoom: 1, duration: 250 }), [flow]);
  useCanvasGestures(root, flow, ZOOM, fit);

  useEffect(() => {
    if (!mulch) return;
    setNodes((current) => toFlowNodes(mulch, fresh, new Map(current.map((node) => [node.id, node]))));
  }, [mulch, fresh]);

  // Show the whole canvas once the cards have their sizes.
  useEffect(() => {
    if (!initialized || fitted.current) return;
    fitted.current = true;
    void flow.fitView({ padding: 0.12, maxZoom: 1 });
  }, [initialized, flow]);

  const edges = useMemo<MulchFlowEdge[]>(
    () =>
      mulch
        ? Object.values(mulch.edges).map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: "floating",
            selectable: false,
            data: { label: edge.label, ai: edge.origin !== "user" },
          }))
        : [],
    [mulch],
  );

  return (
    <ReactFlow<FlowNode, MulchFlowEdge>
      ref={root}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      // Nothing can be moved or selected; only measurements come back, which edges need.
      onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes.filter((c) => c.type === "dimensions"), current))}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      // With nothing selectable or draggable, React Flow lets clicks pass through cards; a handler keeps their buttons and links working.
      onNodeClick={() => undefined}
      deleteKeyCode={null}
      zoomOnDoubleClick={false}
      minZoom={ZOOM.min}
      maxZoom={ZOOM.max}
      panOnScroll
      panOnDrag
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="rgba(0,0,0,0.14)" bgColor="var(--paper)" />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}

const openHref = () => `mlch://open?share=${encodeURIComponent(`${location.origin}/api/shares/${shareId}/manifest`)}`;

export function Viewer() {
  const { status, live } = useShare();
  const title = useMulch((s) => s.mulch?.title);

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  if (status === "missing") {
    return <main className="h-full grid place-items-center text-[14px] text-ink-3">Not found.</main>;
  }
  return (
    <main className="h-full flex">
      <div className="relative flex-1 min-w-0">
        {status === "ready" && (
          <ReactFlowProvider>
            <Board />
          </ReactFlowProvider>
        )}
        <header className="absolute inset-x-0 top-0 h-[60px] px-3 flex items-center gap-2 z-10 pointer-events-none">
          {title && (
            <div className="pointer-events-auto float rounded-xl h-9 flex items-center gap-2.5 px-3 min-w-0">
              <span className="text-[14.5px] font-semibold tracking-[-0.005em] truncate">{title}</span>
              {live ? (
                <span className="flex items-center gap-1.5 text-[12.5px] text-ink-2 shrink-0" data-testid="live">
                  <span className="h-2 w-2 rounded-full bg-amber" />
                  Live
                </span>
              ) : (
                <span className="text-[12.5px] text-ink-3 shrink-0" data-testid="not-live">
                  No longer live
                </span>
              )}
            </div>
          )}
          <div className="flex-1" />
          {status === "ready" && (
            <a href={openHref()} className="pointer-events-auto h-9 px-3.5 rounded-xl bg-ink text-paper text-[13.5px] font-medium flex items-center shadow-[var(--float-shadow)]">
              Open in mlch
            </a>
          )}
        </header>
        <ArtifactViewer />
      </div>
      <SidePanel />
    </main>
  );
}
