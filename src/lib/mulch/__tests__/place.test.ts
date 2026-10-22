import { describe, expect, it } from "vitest";
import { arrangeGroups, GAP, holdSpace, placeNear } from "../place";
import { overlaps, rectOf } from "../sizes";
import { mulchWith, node } from "./fixtures";

describe("placeNear", () => {
  it("puts the first node at the origin", () => {
    expect(placeNear(mulchWith(), { w: 200, h: 100 })).toEqual({ x: -100, y: -50 });
  });

  it("never overlaps existing nodes and stays near its anchor", () => {
    const mulch = mulchWith(
      node("a", { x: 0, y: 0, w: 240, h: 90 }),
      node("b", { x: 300, y: 0, w: 240, h: 90 }),
      node("c", { x: 0, y: 140, w: 240, h: 90 }),
    );
    for (let i = 0; i < 20; i++) {
      const size = { w: 240, h: 90 };
      const p = placeNear(mulch, size, { anchorIds: ["a"], seed: `n${i}` });
      const rect = { ...p, ...size };
      for (const other of Object.values(mulch.nodes)) expect(overlaps(rect, rectOf(other), GAP - 1)).toBe(false);
      expect(Math.hypot(p.x, p.y)).toBeLessThan(1500);
      mulch.nodes[`n${i}`] = node(`n${i}`, { ...p, ...size, createdAt: 2 + i });
    }
  });

  it("keeps clear of space held for a running job until it is released", () => {
    const mulch = mulchWith();
    const held = { x: -100, y: -50, w: 200, h: 100 };
    holdSpace(mulch.id, "job-1", held);
    const p = placeNear(mulch, { w: 200, h: 100 });
    expect(overlaps({ ...p, w: 200, h: 100 }, held, GAP - 1)).toBe(false);
    holdSpace(mulch.id, "job-1", undefined);
    expect(placeNear(mulch, { w: 200, h: 100 })).toEqual({ x: -100, y: -50 });
  });

  it("is deterministic for the same seed", () => {
    const mulch = mulchWith(node("a", { w: 240, h: 90 }));
    const one = placeNear(mulch, { w: 100, h: 100 }, { anchorIds: ["a"], seed: "x" });
    expect(placeNear(mulch, { w: 100, h: 100 }, { anchorIds: ["a"], seed: "x" })).toEqual(one);
  });
});

describe("arrangeGroups", () => {
  it("packs groups without overlaps and leaves other nodes alone", () => {
    const ids = Array.from({ length: 7 }, (_, i) => `n${i}`);
    const mulch = mulchWith(
      ...ids.map((id, i) => node(id, { x: i * 37, y: i * 11, w: 240, h: 80 + i * 10 })),
      node("stay", { x: 400, y: 0, w: 240, h: 90 }),
    );
    const { moves, boxes } = arrangeGroups(mulch, [
      { title: "One", nodeIds: ["n0", "n1", "n2", "n3"] },
      { title: "Two", nodeIds: ["n4", "n5", "n6", "missing"] },
    ]);
    expect(moves).toHaveLength(7);
    expect(moves.some((m) => m.id === "stay")).toBe(false);
    const rects = moves.map((m) => ({ ...rectOf(mulch.nodes[m.id]), x: m.x, y: m.y }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false);
    }
    for (const box of boxes) {
      expect(overlaps(box, rectOf(mulch.nodes.stay))).toBe(false);
      for (const id of box.nodeIds) {
        const r = rects[moves.findIndex((m) => m.id === id)];
        expect(r.x >= box.x && r.y >= box.y && r.x + r.w <= box.x + box.w && r.y + r.h <= box.y + box.h).toBe(true);
      }
    }
  });

  it("puts a node named twice in the first group only", () => {
    const mulch = mulchWith(node("a"), node("b"));
    const { boxes } = arrangeGroups(mulch, [
      { title: "X", nodeIds: ["a", "b"] },
      { title: "Y", nodeIds: ["a"] },
    ]);
    expect(boxes.map((b) => b.nodeIds)).toEqual([["a", "b"]]);
  });
});

describe("a call's topics", () => {
  it("run left to right, hold their cards in columns without overlap, and grow down", async () => {
    const { placeInTopic, grownTopic, topicBox, TOPIC_W } = await import("../place");
    const mulch = mulchWith(node("t", { x: 0, y: 0, w: 320, h: 260 }));
    const first = topicBox(mulch, { near: ["t"] });
    expect(first.x).toBeGreaterThan(320);
    expect(first.w).toBe(TOPIC_W);
    mulch.groups.g1 = { id: "g1", title: "Pricing", ...first, origin: "agent:call", createdAt: 1 };
    const second = topicBox(mulch, { after: "g1" });
    expect(second.x).toBeGreaterThan(first.x + first.w);
    expect(second.y).toBe(first.y);
    for (let i = 0; i < 7; i++) {
      const size = { w: 280, h: 120 };
      const p = placeInTopic(mulch, "g1", size)!;
      expect(p.x).toBeGreaterThanOrEqual(first.x);
      expect(p.x + size.w).toBeLessThanOrEqual(first.x + first.w);
      const rect = { ...p, ...size };
      for (const other of Object.values(mulch.nodes)) expect(overlaps(rect, rectOf(other))).toBe(false);
      mulch.nodes[`c${i}`] = node(`c${i}`, { ...p, ...size, groupId: "g1", createdAt: 2 + i });
    }
    // Three to a row: the seventh starts a third row.
    const ys = [...new Set(Object.values(mulch.nodes).filter((n) => n.groupId).map((n) => n.y))];
    expect(ys).toHaveLength(3);
    const box = grownTopic(mulch, "g1")!;
    expect(box.x).toBe(first.x);
    expect(box.w).toBe(first.w);
    expect(box.h).toBeGreaterThan(first.h);
  });
});
