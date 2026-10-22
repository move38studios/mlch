// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let library: string;
beforeEach(() => {
  library = fs.mkdtempSync(path.join(os.tmpdir(), "mlch-projects-"));
  process.env.MLCH_LIBRARY = library;
  delete (globalThis as { __mlchStore?: unknown }).__mlchStore;
});
afterEach(() => fs.rmSync(library, { recursive: true, force: true }));

describe("projects", () => {
  it("hold mulches, travel with them, and leave them when deleted", async () => {
    const store = await import("@/lib/mulch/store");
    const projects = await import("../projects");
    const words = await import("@/lib/words/words");
    const a = await store.createMulch("Call one");
    const b = await store.createMulch("Call two");
    const c = await store.createMulch("Elsewhere");
    const lab = await projects.createProject("  Preconscious   Labs ");
    expect(lab.name).toBe("Preconscious Labs");
    await projects.setProject(a.id, lab.id);
    await projects.setProject(b.id, lab.id);
    expect((await projects.projectMulches(lab.id)).sort()).toEqual([a.id, b.id].sort());
    expect((await projects.projectOf(a.id))?.name).toBe("Preconscious Labs");
    expect(await projects.projectOf(c.id)).toBeUndefined();
    await expect(projects.setProject(c.id, "p-nope")).rejects.toThrow();

    // Listed with their project.
    await store.applyToMulch(a.id, [{ op: "addNode", node: { id: "n", kind: "note", x: 0, y: 0, text: "x", origin: "user", createdAt: 1 } }], "user");
    const listed = await store.listMulches();
    expect(listed.find((m) => m.id === a.id)?.project).toBe(lab.id);

    // The prompt block: the project, its other canvases, its words.
    await words.addWord({ term: "Pipi", project: lab.id, from: "person" });
    const block = await projects.projectBlock(a.id, async (id) => (await store.peekMulch(id))?.title);
    expect(block).toContain('"Preconscious Labs"');
    expect(block).toContain(`${b.id} "Call two"`);
    expect(block).not.toContain(`${a.id} "Call one"`);
    expect(block).toContain("- Pipi");

    await projects.renameProject(lab.id, "Lab");
    expect((await projects.listProjects())[0].name).toBe("Lab");
    await projects.deleteProject(lab.id);
    expect(await projects.listProjects()).toEqual([]);
    expect(await projects.projectOf(a.id)).toBeUndefined();
    expect(fs.existsSync(path.join(library, a.id, "project.json"))).toBe(false);
  });
});
