// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOps } from "../ops";
import { mulchWith, node } from "./fixtures";

let library: string;
beforeEach(() => {
  library = fs.mkdtempSync(path.join(os.tmpdir(), "mulch-history-"));
  process.env.MLCH_LIBRARY = library;
  delete (globalThis as { __mlchStore?: unknown }).__mlchStore;
  delete (globalThis as { __mlchHistory?: unknown }).__mlchHistory;
});
afterEach(() => fs.rmSync(library, { recursive: true, force: true }));

describe("diffOps", () => {
  it("turns one mulch into another", async () => {
    const { diffOps } = await import("../history");
    const a = applyOps(mulchWith(node("x", { title: "t" }), node("y")), [
      { op: "addEdge", edge: { id: "e", source: "x", target: "y", origin: "user", createdAt: 1 } },
      { op: "addGroup", group: { id: "g", title: "G", x: 0, y: 0, w: 5, h: 5, origin: "user", createdAt: 1 } },
    ]);
    const b = applyOps(mulchWith(node("x", { x: 50 }), node("z")), [
      { op: "addEdge", edge: { id: "f", source: "z", target: "x", label: "l", origin: "user", createdAt: 1 } },
      { op: "setTitle", title: "B" },
    ]);
    const result = applyOps(a, diffOps(a, b));
    expect({ ...result, updatedAt: 0 }).toEqual({ ...b, updatedAt: 0 });
  });
});

describe("checkpoints", () => {
  it("dedupes unchanged content and restores", async () => {
    const store = await import("../store");
    const history = await import("../history");
    const mulch = await store.createMulch("H");
    await store.applyToMulch(mulch.id, [{ op: "addNode", node: node("a") }], "user");
    const first = await history.checkpoint(mulch.id, "edit");
    expect(first).toBeDefined();
    // Only a measured height changed: no new checkpoint.
    await store.applyToMulch(mulch.id, [{ op: "updateNode", id: "a", patch: { h: 99 } }], "user");
    expect(await history.checkpoint(mulch.id, "edit")).toBeUndefined();
    await store.applyToMulch(mulch.id, [{ op: "addNode", node: node("b") }, { op: "updateNode", id: "a", patch: { text: "changed" } }], "user");
    await history.checkpoint(mulch.id, "job", "Capturing");
    expect((await history.listCheckpoints(mulch.id)).map((c) => c.kind)).toEqual(["edit", "job"]);

    await history.restoreCheckpoint(mulch.id, first!.at);
    const restored = await store.getMulch(mulch.id);
    expect(Object.keys(restored.nodes)).toEqual(["a"]);
    expect(restored.nodes.a.text).toBe("a");
    expect((await history.listCheckpoints(mulch.id)).map((c) => c.kind)).toEqual(["edit", "job", "pre-restore", "restore"]);
  });
});
