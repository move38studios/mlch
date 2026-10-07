import { describe, expect, it } from "vitest";
import { applyOps, invertOps } from "../ops";
import type { NapkinOp } from "../types";
import { napkinWith, node } from "./fixtures";

const edge = (id: string, source: string, target: string) => ({ id, source, target, origin: "user", createdAt: 1 });

describe("applyOps", () => {
  it("adds, updates and removes nodes, dropping their edges", () => {
    let napkin = napkinWith(node("a"), node("b"));
    napkin = applyOps(napkin, [
      { op: "addEdge", edge: edge("e1", "a", "b") },
      { op: "updateNode", id: "a", patch: { x: 50, title: "A" } },
    ]);
    expect(napkin.nodes.a).toMatchObject({ x: 50, title: "A" });
    expect(Object.keys(napkin.edges)).toEqual(["e1"]);
    napkin = applyOps(napkin, [{ op: "removeNode", id: "b" }]);
    expect(napkin.nodes.b).toBeUndefined();
    expect(napkin.edges).toEqual({});
  });

  it("skips stale ops instead of throwing", () => {
    const napkin = napkinWith(node("a"));
    const next = applyOps(napkin, [
      { op: "updateNode", id: "gone", patch: { x: 1 } },
      { op: "addEdge", edge: edge("e1", "a", "gone") },
      { op: "addEdge", edge: edge("e2", "a", "a") },
      { op: "removeEdge", id: "nope" },
    ]);
    expect(next).toBe(napkin);
  });

  it("clears a field patched with null", () => {
    const napkin = applyOps(napkinWith(node("a", { title: "T" })), [{ op: "updateNode", id: "a", patch: { title: null } }]);
    expect("title" in napkin.nodes.a).toBe(false);
  });

  it("removing a group releases its members", () => {
    let napkin = napkinWith(node("a", { groupId: "g" }));
    napkin = applyOps(napkin, [{ op: "addGroup", group: { id: "g", title: "G", x: 0, y: 0, w: 10, h: 10, origin: "user", createdAt: 1 } }]);
    napkin = applyOps(napkin, [{ op: "removeGroup", id: "g" }]);
    expect(napkin.groups).toEqual({});
    expect(napkin.nodes.a.groupId).toBeUndefined();
  });

  it("stamps updatedAt only when something changed", () => {
    const napkin = napkinWith(node("a"));
    expect(applyOps(napkin, [{ op: "removeNode", id: "x" }], 99).updatedAt).toBe(1);
    expect(applyOps(napkin, [{ op: "removeNode", id: "a" }], 99).updatedAt).toBe(99);
  });
});

describe("invertOps", () => {
  const cases: Array<[string, NapkinOp[]]> = [
    ["add node", [{ op: "addNode", node: node("c", { x: 9 }) }]],
    ["move node", [{ op: "updateNode", id: "a", patch: { x: 100, y: 200, userTouched: true } }]],
    ["remove node with edges", [{ op: "removeNode", id: "a" }]],
    ["add and label edge", [{ op: "addEdge", edge: edge("e2", "b", "a") }, { op: "updateEdge", id: "e2", patch: { label: "x" } }]],
    ["title", [{ op: "setTitle", title: "New" }]],
    [
      "group lifecycle",
      [
        { op: "addGroup", group: { id: "g", title: "G", x: 0, y: 0, w: 10, h: 10, origin: "user", createdAt: 1 } },
        { op: "updateNode", id: "a", patch: { groupId: "g" } },
        { op: "updateGroup", id: "g", patch: { title: "H" } },
      ],
    ],
  ];
  for (const [name, ops] of cases) {
    it(`restores the napkin after: ${name}`, () => {
      const before = applyOps(napkinWith(node("a"), node("b")), [{ op: "addEdge", edge: edge("e1", "a", "b") }]);
      const after = applyOps(before, ops);
      expect(after).not.toEqual(before);
      expect(applyOps(after, invertOps(before, ops))).toEqual(before);
    });
  }
});
