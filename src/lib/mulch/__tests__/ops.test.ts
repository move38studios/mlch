import { describe, expect, it } from "vitest";
import { applyOps, invertOps } from "../ops";
import type { MulchOp } from "../types";
import { mulchWith, node } from "./fixtures";

const edge = (id: string, source: string, target: string) => ({ id, source, target, origin: "user", createdAt: 1 });

describe("applyOps", () => {
  it("adds, updates and removes nodes, dropping their edges", () => {
    let mulch = mulchWith(node("a"), node("b"));
    mulch = applyOps(mulch, [
      { op: "addEdge", edge: edge("e1", "a", "b") },
      { op: "updateNode", id: "a", patch: { x: 50, title: "A" } },
    ]);
    expect(mulch.nodes.a).toMatchObject({ x: 50, title: "A" });
    expect(Object.keys(mulch.edges)).toEqual(["e1"]);
    mulch = applyOps(mulch, [{ op: "removeNode", id: "b" }]);
    expect(mulch.nodes.b).toBeUndefined();
    expect(mulch.edges).toEqual({});
  });

  it("skips stale ops instead of throwing", () => {
    const mulch = mulchWith(node("a"));
    const next = applyOps(mulch, [
      { op: "updateNode", id: "gone", patch: { x: 1 } },
      { op: "addEdge", edge: edge("e1", "a", "gone") },
      { op: "addEdge", edge: edge("e2", "a", "a") },
      { op: "removeEdge", id: "nope" },
    ]);
    expect(next).toBe(mulch);
  });

  it("clears a field patched with null", () => {
    const mulch = applyOps(mulchWith(node("a", { title: "T" })), [{ op: "updateNode", id: "a", patch: { title: null } }]);
    expect("title" in mulch.nodes.a).toBe(false);
  });

  it("removing a group releases its members", () => {
    let mulch = mulchWith(node("a", { groupId: "g" }));
    mulch = applyOps(mulch, [{ op: "addGroup", group: { id: "g", title: "G", x: 0, y: 0, w: 10, h: 10, origin: "user", createdAt: 1 } }]);
    mulch = applyOps(mulch, [{ op: "removeGroup", id: "g" }]);
    expect(mulch.groups).toEqual({});
    expect(mulch.nodes.a.groupId).toBeUndefined();
  });

  it("stamps updatedAt only when something changed", () => {
    const mulch = mulchWith(node("a"));
    expect(applyOps(mulch, [{ op: "removeNode", id: "x" }], 99).updatedAt).toBe(1);
    expect(applyOps(mulch, [{ op: "removeNode", id: "a" }], 99).updatedAt).toBe(99);
  });
});

describe("invertOps", () => {
  const cases: Array<[string, MulchOp[]]> = [
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
    it(`restores the mulch after: ${name}`, () => {
      const before = applyOps(mulchWith(node("a"), node("b")), [{ op: "addEdge", edge: edge("e1", "a", "b") }]);
      const after = applyOps(before, ops);
      expect(after).not.toEqual(before);
      expect(applyOps(after, invertOps(before, ops))).toEqual(before);
    });
  }
});
