// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { overlaps, rectOf } from "@/lib/mulch/sizes";

let library: string;
beforeEach(() => {
  library = fs.mkdtempSync(path.join(os.tmpdir(), "mulch-tools-"));
  process.env.MLCH_LIBRARY = library;
  delete (globalThis as { __mlchStore?: unknown }).__mlchStore;
});
afterEach(() => fs.rmSync(library, { recursive: true, force: true }));

async function setup(tools: string[], extra: Record<string, unknown> = {}) {
  const store = await import("@/lib/mulch/store");
  const { createMulchTools } = await import("../tools");
  const mulch = await store.createMulch("T");
  await store.applyToMulch(
    mulch.id,
    [
      { op: "addNode", node: { id: "mine", kind: "note", x: 0, y: 0, text: "user note", origin: "user", createdAt: 1 } },
      { op: "addNode", node: { id: "said", kind: "idea", x: 400, y: 0, text: "spoken", origin: "speech:j0", createdAt: 2 } },
      { op: "addNode", node: { id: "ai", kind: "example", x: 800, y: 0, text: "ai example", origin: "agent:j0", createdAt: 3 } },
    ],
    "user",
  );
  const ctx = { mulchId: mulch.id, jobId: "j1", tools, added: [] as string[], ...extra };
  return { store, mulch, ctx, runtime: createMulchTools(ctx as never) };
}

describe("mulch tools", () => {
  it("add_nodes places items near anchors without overlap and resolves refs in edges", async () => {
    const { store, mulch, ctx, runtime } = await setup(["add_nodes"]);
    const result = await runtime.execute("add_nodes", {
      nodes: [
        { ref: "q", kind: "question", text: "why?", near: ["said"] },
        { ref: "d", kind: "definition", title: "Term", text: "meaning", near: ["q"] },
      ],
      edges: [
        { from: "q", to: "said", label: "asks" },
        { from: "d", to: "q" },
        { from: "d", to: "nope" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("unknown nope");
    const after = await store.getMulch(mulch.id);
    expect(ctx.added).toHaveLength(2);
    expect(Object.keys(after.edges)).toHaveLength(2);
    const rects = Object.values(after.nodes).map(rectOf);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false);
    expect(after.nodes[ctx.added[0]].origin).toBe("agent:j1");
  });

  it("protects what the person made or said unless allowed", async () => {
    const { store, mulch, runtime } = await setup(["update_node", "remove_nodes"]);
    expect((await runtime.execute("update_node", { id: "mine", text: "x" })).ok).toBe(false);
    expect((await runtime.execute("update_node", { id: "said", text: "x" })).ok).toBe(false);
    expect((await runtime.execute("update_node", { id: "ai", text: "better" })).ok).toBe(true);
    const removed = await runtime.execute("remove_nodes", { ids: ["mine", "ai"] });
    expect(removed.text).toContain("Kept mine");
    const after = await store.getMulch(mulch.id);
    expect(Object.keys(after.nodes).sort()).toEqual(["mine", "said"]);

    const allowed = await setup(["remove_nodes"], { allowUserEdits: true });
    await allowed.runtime.execute("remove_nodes", { ids: ["mine"] });
    expect((await allowed.store.getMulch(allowed.mulch.id)).nodes.mine).toBeUndefined();
  });

  it("arrange creates group boxes and write_doc saves a file", async () => {
    const { store, mulch, runtime } = await setup(["arrange", "write_doc"], { allowUserEdits: true });
    const arranged = await runtime.execute("arrange", { groups: [{ title: "A", ids: ["mine", "said"] }, { title: "B", ids: ["ai"] }] });
    expect(arranged.ok).toBe(true);
    let after = await store.getMulch(mulch.id);
    expect(Object.values(after.groups).map((g) => g.title).sort()).toEqual(["A", "B"]);
    expect(after.nodes.mine.groupId).toBe(after.nodes.said.groupId);

    const doc = await runtime.execute("write_doc", { title: "My Summary", markdown: "Body", near: ["ai"] });
    expect(doc.ok).toBe(true);
    after = await store.getMulch(mulch.id);
    const writeup = Object.values(after.nodes).find((n) => n.kind === "writeup")!;
    expect(writeup.docPath).toBe("docs/my-summary.md");
    expect(fs.readFileSync(path.join(library, mulch.id, "docs/my-summary.md"), "utf8")).toBe("# My Summary\n\nBody");
  });

  it("file tools stay inside the folder", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mulch-root-"));
    fs.writeFileSync(path.join(root, "a.md"), "hello");
    const { runtime } = await setup(["list_files", "read_file"], { readRoot: root });
    expect((await runtime.execute("list_files", { path: "" })).text).toContain("a.md");
    expect((await runtime.execute("read_file", { path: "a.md" })).text).toBe("hello");
    expect((await runtime.execute("read_file", { path: "../etc/passwd" })).ok).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects tools not given to the job and bad input", async () => {
    const { runtime } = await setup(["connect"]);
    expect((await runtime.execute("remove_nodes", { ids: ["ai"] })).ok).toBe(false);
    expect((await runtime.execute("connect", { edges: [] })).ok).toBe(false);
  });
});
