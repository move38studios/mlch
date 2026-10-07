// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOps } from "../ops";
import { napkinWith, node } from "./fixtures";

let library: string;
beforeEach(() => {
  library = fs.mkdtempSync(path.join(os.tmpdir(), "mulch-history-"));
  process.env.MULCH_LIBRARY = library;
  delete (globalThis as { __mulchStore?: unknown }).__mulchStore;
  delete (globalThis as { __mulchHistory?: unknown }).__mulchHistory;
});
afterEach(() => fs.rmSync(library, { recursive: true, force: true }));

describe("diffOps", () => {
  it("turns one napkin into another", async () => {
    const { diffOps } = await import("../history");
    const a = applyOps(napkinWith(node("x", { title: "t" }), node("y")), [
      { op: "addEdge", edge: { id: "e", source: "x", target: "y", origin: "user", createdAt: 1 } },
      { op: "addGroup", group: { id: "g", title: "G", x: 0, y: 0, w: 5, h: 5, origin: "user", createdAt: 1 } },
    ]);
    const b = applyOps(napkinWith(node("x", { x: 50 }), node("z")), [
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
    const napkin = await store.createNapkin("H");
    await store.applyToNapkin(napkin.id, [{ op: "addNode", node: node("a") }], "user");
    const first = await history.checkpoint(napkin.id, "edit");
    expect(first).toBeDefined();
    // Only a measured height changed: no new checkpoint.
    await store.applyToNapkin(napkin.id, [{ op: "updateNode", id: "a", patch: { h: 99 } }], "user");
    expect(await history.checkpoint(napkin.id, "edit")).toBeUndefined();
    await store.applyToNapkin(napkin.id, [{ op: "addNode", node: node("b") }, { op: "updateNode", id: "a", patch: { text: "changed" } }], "user");
    await history.checkpoint(napkin.id, "job", "Capturing");
    expect((await history.listCheckpoints(napkin.id)).map((c) => c.kind)).toEqual(["edit", "job"]);

    await history.restoreCheckpoint(napkin.id, first!.at);
    const restored = await store.getNapkin(napkin.id);
    expect(Object.keys(restored.nodes)).toEqual(["a"]);
    expect(restored.nodes.a.text).toBe("a");
    expect((await history.listCheckpoints(napkin.id)).map((c) => c.kind)).toEqual(["edit", "job", "pre-restore", "restore"]);
  });
});
