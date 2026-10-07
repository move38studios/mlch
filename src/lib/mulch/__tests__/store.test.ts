// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let library: string;
beforeEach(() => {
  library = fs.mkdtempSync(path.join(os.tmpdir(), "mulch-store-"));
  process.env.MULCH_LIBRARY = library;
  delete (globalThis as { __mulchStore?: unknown }).__mulchStore;
});
afterEach(() => fs.rmSync(library, { recursive: true, force: true }));

describe("mulch store", () => {
  it("creates, applies, persists, lists and trashes", async () => {
    const store = await import("../store");
    const mulch = await store.createMulch("One");
    const events: string[] = [];
    const unsubscribe = await store.subscribe(mulch.id, (event) => events.push(event.type));
    const batch = await store.applyToMulch(
      mulch.id,
      [{ op: "addNode", node: { id: "a", kind: "idea", x: 0, y: 0, text: "hi", origin: "user", createdAt: 1 } }],
      "user",
      "client-1",
    );
    expect(batch?.clientId).toBe("client-1");
    expect(await store.applyToMulch(mulch.id, [{ op: "removeNode", id: "missing" }], "user")).toBeUndefined();
    expect(events).toEqual(["snapshot", "ops"]);
    unsubscribe();

    await store.flushAll();
    const dir = path.join(library, mulch.id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "mulch.json"), "utf8")).nodes.a.text).toBe("hi");
    expect(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);

    // A fresh process reads it back from disk.
    delete (globalThis as { __mulchStore?: unknown }).__mulchStore;
    expect((await store.getMulch(mulch.id)).nodes.a.text).toBe("hi");
    expect((await store.listMulches()).map((s) => [s.title, s.nodeCount])).toEqual([["One", 1]]);

    await store.trashMulch(mulch.id);
    expect(await store.listMulches()).toEqual([]);
    expect(fs.readdirSync(path.join(library, ".trash"))).toHaveLength(1);
  });

  it("refuses ids that could leave the library", async () => {
    const store = await import("../store");
    await expect(store.getMulch("../etc")).rejects.toBeInstanceOf(store.MulchNotFoundError);
    await expect(store.getMulch("20260101-0000-abcdef")).rejects.toBeInstanceOf(store.MulchNotFoundError);
  });
});
