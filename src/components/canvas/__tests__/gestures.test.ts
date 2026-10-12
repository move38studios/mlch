import { describe, expect, it } from "vitest";
import { classifyWheel, GESTURE_GAP_MS, zoomAt, zoomKey } from "../gestures";

describe("classifyWheel", () => {
  it("tells a mouse wheel from a trackpad", () => {
    // Chromium on macOS: a wheel notch, and trackpad scroll (wheelDeltaY = -3 × deltaY).
    expect(classifyWheel({ deltaX: 0, deltaY: 100, deltaMode: 0, wheelDeltaY: -120 })).toBe("mouse");
    expect(classifyWheel({ deltaX: 0, deltaY: 4, deltaMode: 0, wheelDeltaY: -12 })).toBe("trackpad");
    expect(classifyWheel({ deltaX: 2, deltaY: 6, deltaMode: 0 })).toBe("trackpad");
    expect(classifyWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toBe("mouse");
    expect(classifyWheel({ deltaX: 0, deltaY: 1.5, deltaMode: 0 })).toBe("trackpad");
    expect(classifyWheel({ deltaX: 0, deltaY: -100, deltaMode: 0 })).toBe("mouse");
  });

  it("keeps the class for the rest of a gesture", () => {
    const notch = { deltaX: 0, deltaY: 100, deltaMode: 0, wheelDeltaY: -120 };
    expect(classifyWheel(notch, { source: "trackpad", at: 1000 }, 1000 + GESTURE_GAP_MS - 1)).toBe("trackpad");
    expect(classifyWheel(notch, { source: "trackpad", at: 1000 }, 1000 + GESTURE_GAP_MS + 1)).toBe("mouse");
  });
});

describe("zoomAt", () => {
  it("keeps the point under the pointer still", () => {
    const before = { x: 100, y: 50, zoom: 1 };
    const pointer = { x: 400, y: 300 };
    const after = zoomAt(before, pointer, -100, 0, { min: 0.1, max: 2 });
    expect(after.zoom).toBeGreaterThan(1);
    const flowPoint = (v: typeof before) => ({ x: (pointer.x - v.x) / v.zoom, y: (pointer.y - v.y) / v.zoom });
    expect(flowPoint(after).x).toBeCloseTo(flowPoint(before).x);
    expect(flowPoint(after).y).toBeCloseTo(flowPoint(before).y);
  });

  it("stays within the limits", () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 1.9 }, { x: 0, y: 0 }, -5000, 0, { min: 0.1, max: 2 }).zoom).toBe(2);
    expect(zoomAt({ x: 0, y: 0, zoom: 0.2 }, { x: 0, y: 0 }, 5000, 0, { min: 0.1, max: 2 }).zoom).toBe(0.1);
  });
});

describe("zoomKey", () => {
  it("maps ⌘ keys to zoom actions", () => {
    const key = (k: string, mods: Partial<KeyboardEvent> = { metaKey: true }) => zoomKey({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });
    expect(key("=")).toBe("in");
    expect(key("+")).toBe("in");
    expect(key("-")).toBe("out");
    expect(key("0")).toBe("fit");
    expect(key("0", {})).toBeUndefined();
    expect(key("z")).toBeUndefined();
  });
});
