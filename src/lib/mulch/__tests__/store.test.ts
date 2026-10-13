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
  it("removes an untitled mulch left empty, and keeps one with something in it", async () => {
    const store = await import("../store");
    const empty = await store.createMulch();
    const used = await store.createMulch();
    const named = await store.createMulch("Named");
    for (const mulch of [empty, used, named]) (await store.subscribe(mulch.id, () => {}))();
    await store.applyToMulch(used.id, [{ op: "addNode", node: { id: "a", kind: "idea", x: 0, y: 0, text: "hi", origin: "user", createdAt: 1 } }], "user");
    expect(await store.removeIfEmpty(empty.id)).toBe(true);
    expect(await store.removeIfEmpty(used.id)).toBe(false);
    expect(await store.removeIfEmpty(named.id)).toBe(false);
    expect(fs.existsSync(path.join(library, empty.id))).toBe(false);

    // Still being looked at: kept.
    const watched = await store.createMulch();
    await store.subscribe(watched.id, () => {});
    expect(await store.removeIfEmpty(watched.id)).toBe(false);
  });

  it("clears empty mulches left behind by an earlier run when listing", async () => {
    const store = await import("../store");
    const old = await store.createMulch();
    const fresh = await store.createMulch();
    const file = path.join(library, old.id, "mulch.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), createdAt: Date.now() - 120_000 }));
    expect((await store.listMulches()).map((s) => s.id)).toEqual([fresh.id]);
    expect(fs.existsSync(path.join(library, old.id))).toBe(false);
  });

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

  it("keeps a closed message closed when the job saves itself again", async () => {
    const store = await import("../store");
    const mulch = await store.createMulch("Message");
    const job = { id: "j1", lane: "command" as const, state: "running" as const, label: "Question", retry: { kind: "command" as const, input: "?" }, message: { text: "An answer", at: 5 } };
    await store.setJob(mulch.id, job);
    await store.dismissJobMessage(mulch.id, "j1");
    await store.setJob(mulch.id, { ...job, state: "done" }); // the job finishing, with its own copy
    expect((await store.getJobs(mulch.id))[0].message).toEqual({ text: "An answer", at: 5, dismissed: true });
    await store.setJob(mulch.id, { ...job, message: { text: "A second one", at: 9 } });
    expect((await store.getJobs(mulch.id))[0].message?.dismissed).toBeUndefined();
  });

  it("archives and restores, and lists how many share links there are", async () => {
    const store = await import("../store");
    const mulch = await store.createMulch("Archive me");
    await store.applyToMulch(mulch.id, [{ op: "addNode", node: { id: "n1", kind: "note", x: 0, y: 0, text: "kept", origin: "user", createdAt: 1 } }], "user");
    fs.writeFileSync(path.join(library, mulch.id, "shares.json"), JSON.stringify([{ id: "s1" }, { id: "s2" }]));
    await store.archiveMulch(mulch.id, true);
    let [summary] = await store.listMulches();
    expect(summary.archivedAt).toBeGreaterThan(0);
    expect(summary.shares).toBe(2);
    await store.archiveMulch(mulch.id, false);
    [summary] = await store.listMulches();
    expect(summary.archivedAt).toBeUndefined();
  });

  it("refuses ids that could leave the library", async () => {
    const store = await import("../store");
    await expect(store.getMulch("../etc")).rejects.toBeInstanceOf(store.MulchNotFoundError);
    await expect(store.getMulch("20260101-0000-abcdef")).rejects.toBeInstanceOf(store.MulchNotFoundError);
  });
});
