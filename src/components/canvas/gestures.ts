/**
 * Canvas gestures, as in maps and whiteboards: a mouse wheel zooms at the
 * pointer; on a trackpad two fingers pan and a pinch zooms (React Flow
 * handles those, and ⌘-wheel). Both devices arrive as wheel events, so a
 * gesture is classified once and keeps its class until it pauses.
 */

import { useEffect, type RefObject } from "react";
import type { ReactFlowInstance, Node, Edge } from "@xyflow/react";
import { desktop } from "@/lib/desktop/client";

export type WheelSource = "mouse" | "trackpad";

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  /** Chromium's legacy field; a trackpad reports exactly -3 × deltaY. */
  wheelDeltaY?: number;
}

/** Events closer together than this belong to one gesture. */
export const GESTURE_GAP_MS = 250;

export function classifyWheel(event: WheelSample, previous?: { source: WheelSource; at: number }, now = Date.now()): WheelSource {
  if (previous && now - previous.at < GESTURE_GAP_MS) return previous.source;
  if (event.deltaMode !== 0) return "mouse";
  if (event.deltaX !== 0) return "trackpad";
  if (event.wheelDeltaY) return Math.abs(event.wheelDeltaY + 3 * event.deltaY) < 1 ? "trackpad" : "mouse";
  return Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 40 ? "mouse" : "trackpad";
}

/** The viewport after zooming by a wheel step, keeping the point under the pointer still. */
export function zoomAt(
  viewport: { x: number; y: number; zoom: number },
  pointer: { x: number; y: number },
  deltaY: number,
  deltaMode: number,
  limits: { min: number; max: number },
): { x: number; y: number; zoom: number } {
  const step = deltaMode === 1 ? deltaY * 0.05 : deltaMode === 2 ? deltaY : deltaY * 0.002;
  const zoom = Math.min(limits.max, Math.max(limits.min, viewport.zoom * Math.pow(2, -step)));
  const scale = zoom / viewport.zoom;
  return { x: pointer.x - (pointer.x - viewport.x) * scale, y: pointer.y - (pointer.y - viewport.y) * scale, zoom };
}

export type ZoomAction = "in" | "out" | "fit";

/** ⌘+ / ⌘= zoom in, ⌘− zoom out, ⌘0 show everything. */
export function zoomKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): ZoomAction | undefined {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return undefined;
  if (event.key === "=" || event.key === "+") return "in";
  if (event.key === "-" || event.key === "_") return "out";
  if (event.key === "0") return "fit";
  return undefined;
}

export function useCanvasGestures<N extends Node, E extends Edge>(
  root: RefObject<HTMLDivElement | null>,
  flow: ReactFlowInstance<N, E>,
  limits: { min: number; max: number },
  fit: () => void,
): void {
  // Mouse wheel: zoom at the pointer instead of React Flow's pan.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let last: { source: WheelSource; at: number } | undefined;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".nowheel")) return;
      const source = classifyWheel(event as WheelEvent & { wheelDeltaY?: number }, last);
      last = { source, at: Date.now() };
      if (source !== "mouse") return;
      event.preventDefault();
      event.stopPropagation();
      const rect = element.getBoundingClientRect();
      flow.setViewport(zoomAt(flow.getViewport(), { x: event.clientX - rect.left, y: event.clientY - rect.top }, event.deltaY, event.deltaMode, limits));
    };
    element.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => element.removeEventListener("wheel", onWheel, { capture: true });
  }, [root, flow, limits]);

  // Zoom keys, and the same commands from the View menu.
  useEffect(() => {
    const act = (action: ZoomAction) => {
      if (action === "in") void flow.zoomIn({ duration: 200 });
      else if (action === "out") void flow.zoomOut({ duration: 200 });
      else fit();
    };
    const onKey = (event: KeyboardEvent) => {
      const action = zoomKey(event);
      if (!action) return;
      event.preventDefault();
      act(action);
    };
    window.addEventListener("keydown", onKey);
    const offMenu = desktop()?.onMenu?.((command) => {
      if (command === "zoom-in") act("in");
      else if (command === "zoom-out") act("out");
      else if (command === "zoom-fit") act("fit");
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      offMenu?.();
    };
  }, [flow, fit]);
}
