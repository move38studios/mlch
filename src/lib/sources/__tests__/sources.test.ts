// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let library: string;
let vault: string;
beforeEach(() => {
  library = fs.mkdtempSync(path.join(os.tmpdir(), "mulch-sources-"));
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  process.env.MLCH_LIBRARY = library;
  process.env.MLCH_NO_EMBEDDINGS = "1";
  for (const key of ["__mlchStore", "__mlchSearch", "__mlchSources"]) delete (globalThis as Record<string, unknown>)[key];
  fs.mkdirSync(path.join(vault, ".obsidian"));
  fs.mkdirSync(path.join(vault, "Ideas"));
  fs.writeFileSync(path.join(vault, "Ideas", "Forest cities.md"), "---\ntags: [urbanism]\n---\nCities planted as forests cool the streets. See [[Biophilia]].");
  fs.writeFileSync(path.join(vault, "Biophilia.md"), "Love of living things, E. O. Wilson.");
  fs.writeFileSync(path.join(vault, ".obsidian", "workspace.md"), "should not be indexed");
  fs.writeFileSync(path.join(vault, "photo.png"), "not text");
  fs.writeFileSync(path.join(vault, ".env"), "SECRET=1");
});
afterEach(() => {
  for (const dir of [library, vault]) fs.rmSync(dir, { recursive: true, force: true });
});

async function link(extra: Record<string, unknown> = {}) {
  const { writeSettings } = await import("@/lib/settings");
  await writeSettings({ sources: [{ id: "vault01", path: vault, name: "Notes", mode: "auto", ...extra }] });
  const sources = await import("../sources");
  const [source] = await sources.syncSources();
  await sources.indexSource(source);
  return { sources, source };
}

describe("linked folders", () => {
  it("indexes notes (not hidden or private files) and finds them with their links and tags", async () => {
    const { sources, source } = await link();
    expect((await sources.listSourceFiles(source)).map((f) => f.path).sort()).toEqual(["Biophilia.md", "Ideas/Forest cities.md"]);
    expect(sources.sourceStatus("vault01")).toMatchObject({ state: "ready", files: 2 });
    expect(sources.isVault(source)).toBe(true);
    const { search } = await import("@/lib/search");
    const hits = await search("forests streets", { mulchIds: [], sources: ["vault01"] });
    expect(hits[0]).toMatchObject({ mulchId: "", sourceId: "vault01", path: "Ideas/Forest cities.md", kind: "file" });
    expect((await search("urbanism", { mulchIds: [], sources: ["vault01"] }))[0]?.path).toBe("Ideas/Forest cities.md");
    // Without the source in the request, nothing from it.
    expect(await search("forests", { mulchIds: [] })).toEqual([]);
    expect(sources.openUrl(source, "Ideas/Forest cities.md")).toMatch(/^obsidian:\/\/open\?vault=vault-/);
  });

  it("re-reads only changed files, and drops deleted ones", async () => {
    const { sources, source } = await link();
    fs.writeFileSync(path.join(vault, "Biophilia.md"), "Changed: the love of life, and mangroves.");
    fs.rmSync(path.join(vault, "Ideas", "Forest cities.md"));
    await sources.indexSource(source);
    expect(sources.sourceStatus("vault01")).toMatchObject({ files: 1, done: 1 });
    const { search } = await import("@/lib/search");
    expect((await search("mangroves", { mulchIds: [], sources: ["vault01"] })).length).toBe(1);
    expect(await search("streets", { mulchIds: [], sources: ["vault01"] })).toEqual([]);
  });

  it("adds notes only where allowed, never over an existing file", async () => {
    const closed = await link();
    await expect(closed.sources.addNote(closed.source, "x", "y")).rejects.toThrow(/may not add notes/);
    const { sources, source } = await link({ writeFolder: "mlch" });
    const first = await sources.addNote(source, "Call: forest/cities", "# Notes");
    const second = await sources.addNote(source, "Call: forest/cities", "# More");
    expect(first).toBe("mlch/Call forest cities.md");
    expect(second).toBe("mlch/Call forest cities 2.md");
    expect(fs.readFileSync(path.join(vault, first), "utf8")).toBe("# Notes");
    const escaping = { ...source, writeFolder: "../outside" };
    await expect(sources.addNote(escaping, "x", "y")).rejects.toThrow(/outside/);
  });

  it("forgets a source removed from Settings", async () => {
    const { sources } = await link();
    const { writeSettings } = await import("@/lib/settings");
    await writeSettings({ sources: [] });
    await sources.syncSources();
    const { search } = await import("@/lib/search");
    expect(await search("forests", { mulchIds: [], sources: ["vault01"] })).toEqual([]);
  });
});
