// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let library: string;
let vault: string;
beforeEach(() => {
  library = fs.mkdtempSync(path.join(os.tmpdir(), "mulch-links-"));
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  process.env.MLCH_LIBRARY = library;
  process.env.MLCH_NO_EMBEDDINGS = "1";
  for (const key of ["__mlchStore", "__mlchSearch", "__mlchSources"]) delete (globalThis as Record<string, unknown>)[key];
  fs.writeFileSync(path.join(vault, "Pricing.md"), "---\ntitle: Pricing notes\n---\nCharge per seat, not per minute.");
});
afterEach(() => {
  for (const dir of [library, vault]) fs.rmSync(dir, { recursive: true, force: true });
});

const idea = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ op: "addNode" as const, node: { id, kind: "idea" as const, x: 0, y: 0, text, origin: "user", createdAt: 1, ...extra } });

async function setup(tools: string[], extra: Record<string, unknown> = {}) {
  const store = await import("@/lib/mulch/store");
  const { writeSettings } = await import("@/lib/settings");
  await writeSettings({ sources: [{ id: "vault01", path: vault, name: "Notes", mode: "auto" }, { id: "work0001", path: vault, name: "Work", mode: "asked" }] });
  const sources = await import("@/lib/sources/sources");
  for (const source of await sources.syncSources()) await sources.indexSource(source);
  const old = await store.createMulch("Pricing call");
  await store.applyToMulch(old.id, [idea("p1", "Seats beat minutes for pricing", { title: "Seat pricing" }), idea("p2", "Teams buy seats"), { op: "addEdge", edge: { id: "e1", source: "p1", target: "p2", origin: "user", createdAt: 1 } }], "user");
  const here = await store.createMulch("New call");
  await store.applyToMulch(here.id, [idea("h1", "How should we price the app?")], "user");
  const { createMulchTools } = await import("@/lib/agent/tools");
  const ctx = { mulchId: here.id, jobId: "j1", tools, added: [] as string[], ...extra };
  return { store, old, here, ctx, runtime: createMulchTools(ctx as never) };
}

describe("links between mulches and to linked folders", () => {
  it("search_all_mulches finds other mulches and linked folders, not the ones kept for when asked", async () => {
    const { runtime } = await setup(["search_all_mulches"]);
    const result = await runtime.execute("search_all_mulches", { query: "seat pricing" });
    expect(result.text).toMatch(/mulch \S+ "Pricing call"/);
    expect(result.text).toContain('folder vault01 "Notes" · file Pricing.md');
    expect(result.text).not.toContain("work0001");
    const asked = (await setup(["search_all_mulches"], { sources: "all" })).runtime;
    expect((await asked.execute("search_all_mulches", { query: "seat" })).text).toContain("work0001");
  });

  it("link_to adds a link card with a reasoned connection, once, and resolves live", async () => {
    const { store, old, here, ctx, runtime } = await setup(["link_to"]);
    const made = await runtime.execute("link_to", { mulch_id: old.id, item_id: "p1", near: "h1", why: "earlier decision" });
    expect(made.ok).toBe(true);
    const mulch = await store.getMulch(here.id);
    const card = mulch.nodes[ctx.added[0]];
    expect(card).toMatchObject({ kind: "ref", ref: { mulchId: old.id, itemId: "p1" }, title: "Seat pricing", text: "" });
    expect(Object.values(mulch.edges)).toEqual([expect.objectContaining({ source: "h1", target: card.id, label: "earlier decision" })]);
    expect((await runtime.execute("link_to", { mulch_id: old.id, item_id: "p1", near: "h1", why: "again" })).ok).toBe(false);
    expect((await runtime.execute("link_to", { mulch_id: here.id, item_id: "h1", near: "h1", why: "self" })).ok).toBe(false);
    expect((await runtime.execute("link_to", { mulch_id: old.id, item_id: "nope", near: "h1", why: "x" })).ok).toBe(false);
    expect((await runtime.execute("link_to", { source_id: "work0001", path: "Pricing.md", near: "h1", why: "same idea" })).text).toContain("for when they ask");
    const note = await runtime.execute("link_to", { source_id: "vault01", path: "Pricing.md", near: "h1", why: "same idea" });
    expect(note.ok).toBe(true);

    const { resolveRef, backlinks } = await import("../links");
    await store.applyToMulch(old.id, [{ op: "updateNode", id: "p1", patch: { text: "Seats, revised" } }], "user");
    expect(await resolveRef({ mulchId: old.id, itemId: "p1" })).toMatchObject({ exists: true, place: "Pricing call", text: "Seats, revised" });
    expect(await resolveRef({ sourceId: "vault01", path: "Pricing.md" })).toMatchObject({ exists: true, place: "Notes", title: "Pricing notes", text: "Charge per seat, not per minute." });
    expect(await backlinks(old.id)).toEqual([{ mulchId: here.id, mulchTitle: "New call", nodeId: card.id, itemId: "p1" }]);
    await store.applyToMulch(old.id, [{ op: "removeNode", id: "p1" }], "user");
    expect(await resolveRef({ mulchId: old.id, itemId: "p1" })).toMatchObject({ exists: false, place: "Pricing call" });
  });

  it("bring here replaces the link card with a copy and keeps its connections", async () => {
    const { store, old, here, ctx, runtime } = await setup(["link_to"]);
    await runtime.execute("link_to", { mulch_id: old.id, item_id: "p1", near: "h1", why: "earlier decision" });
    const { bringHere } = await import("../links");
    const id = await bringHere(here.id, ctx.added[0]);
    const mulch = await store.getMulch(here.id);
    expect(mulch.nodes[ctx.added[0]]).toBeUndefined();
    expect(mulch.nodes[id!]).toMatchObject({ kind: "idea", title: "Seat pricing", origin: "user" });
    expect(mulch.nodes[id!].text).toContain('(From "Pricing call")');
    expect(Object.values(mulch.edges)).toEqual([expect.objectContaining({ source: "h1", target: id, label: "earlier decision" })]);
  });

  it("read_source reads another mulch's item and a linked note", async () => {
    const { old, runtime } = await setup(["read_source"]);
    expect((await runtime.execute("read_source", { id: "p1", mulch_id: old.id })).text).toContain("Seats beat minutes");
    expect((await runtime.execute("read_source", { source_id: "vault01", path: "Pricing.md" })).text).toContain("Charge per seat");
    expect((await runtime.execute("read_source", { source_id: "vault01", path: "../etc/passwd" })).ok).toBe(false);
  });

  it("copies pasted cards' files: assets from another mulch, made files under a new name", async () => {
    const { store, old, here } = await setup([]);
    const { copyCardFiles } = await import("../links");
    const asset = `${"a".repeat(64)}.png`;
    fs.mkdirSync(path.join(store.mulchDir(old.id), "assets"), { recursive: true });
    fs.writeFileSync(path.join(store.mulchDir(old.id), "assets", asset), "png");
    fs.writeFileSync(path.join(store.mulchDir(old.id), "assets", `${"a".repeat(64)}.md`), "its text");
    fs.mkdirSync(path.join(store.mulchDir(old.id), "artifacts"), { recursive: true });
    fs.writeFileSync(path.join(store.mulchDir(old.id), "artifacts", "deck.html"), "<p>deck</p>");

    const moved = await copyCardFiles(here.id, old.id, [asset, "../../x"], ["artifacts/deck.html", "../secret.txt", "artifacts/gone.html"]);
    expect(moved).toEqual({ "artifacts/deck.html": "artifacts/deck-2.html" });
    expect(fs.readFileSync(path.join(store.mulchDir(here.id), "assets", asset), "utf8")).toBe("png");
    expect(fs.readFileSync(path.join(store.mulchDir(here.id), "assets", `${"a".repeat(64)}.md`), "utf8")).toBe("its text");
    expect(fs.readFileSync(path.join(store.mulchDir(here.id), "artifacts", "deck-2.html"), "utf8")).toBe("<p>deck</p>");
    // Duplicated in the same mulch: its own copy, next free name.
    expect(await copyCardFiles(old.id, old.id, [asset], ["artifacts/deck.html"])).toEqual({ "artifacts/deck.html": "artifacts/deck-2.html" });
    expect(await copyCardFiles(old.id, old.id, [], ["artifacts/deck.html"])).toEqual({ "artifacts/deck.html": "artifacts/deck-3.html" });
  });
});
