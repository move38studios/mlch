// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let library: string;
beforeEach(() => {
  library = fs.mkdtempSync(path.join(os.tmpdir(), "mulch-store-"));
  process.env.MLCH_LIBRARY = library;
  delete (globalThis as { __mlchStore?: unknown }).__mlchStore;
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
    delete (globalThis as { __mlchStore?: unknown }).__mlchStore;
    expect((await store.getMulch(mulch.id)).nodes.a.text).toBe("hi");
    expect((await store.listMulches()).map((s) => [s.title, s.nodeCount])).toEqual([["One", 1]]);

    await store.trashMulch(mulch.id);
    expect(await store.listMulches()).toEqual([]);
    expect(fs.readdirSync(path.join(library, ".trash"))).toHaveLength(1);
  });

  it("keeps the person's jobs, marks interrupted ones failed, and counts them for the list", async () => {
    const store = await import("../store");
    const mulch = await store.createMulch("Jobs");
    const retry = { kind: "make" as const, input: "a deck" };
    await store.setJob(mulch.id, { id: "j1", lane: "long", state: "running", label: "Deck", retry, startedAt: 1 });
    await store.setJob(mulch.id, { id: "j2", lane: "command", state: "done", label: "Summary", retry: { kind: "command", input: "sum" }, unseen: true, resultIds: ["n1"] });
    await store.setJob(mulch.id, { id: "j3", lane: "fast", state: "done", label: "Capturing" });
    expect((await store.listMulches())[0].activity).toEqual({ working: 1, unseen: 1, failed: 0 });
    await new Promise((resolve) => setTimeout(resolve, 600)); // jobs.json is written after a short pause
    const saved = JSON.parse(fs.readFileSync(path.join(library, mulch.id, "jobs.json"), "utf8")) as Array<{ id: string }>;
    expect(saved.map((job) => job.id)).toEqual(["j1", "j2"]); // capture is not kept
    // A new process: the running deck was stopped by the quit.
    delete (globalThis as { __mlchStore?: unknown }).__mlchStore;
    const fresh = await import("../store");
    const jobs = await fresh.getJobs(mulch.id);
    expect(jobs.find((job) => job.id === "j1")).toMatchObject({ state: "failed", unseen: true, error: "Stopped when mlch quit." });
    expect((await fresh.listMulches())[0].activity).toEqual({ working: 0, unseen: 1, failed: 1 });
    await fresh.markJobsSeen(mulch.id, ["j1", "j2"]);
    expect((await fresh.listMulches())[0].activity).toEqual({ working: 0, unseen: 0, failed: 0 });
  });

  it("refuses ids that could leave the library", async () => {
    const store = await import("../store");
    await expect(store.getMulch("../etc")).rejects.toBeInstanceOf(store.MulchNotFoundError);
    await expect(store.getMulch("20260101-0000-abcdef")).rejects.toBeInstanceOf(store.MulchNotFoundError);
  });
});
