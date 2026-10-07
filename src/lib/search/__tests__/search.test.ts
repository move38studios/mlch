// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkText } from "../chunk";

describe("chunkText", () => {
  it("cuts long text into overlapping passages with page numbers", () => {
    const pages = Array.from({ length: 3 }, (_, i) => `--- page ${i + 1} ---\n\n${`Sentence ${i + 1} about forests. `.repeat(60)}`).join("\n\n");
    const passages = chunkText(pages);
    expect(passages.length).toBeGreaterThan(3);
    expect(passages[0].page).toBe(1);
    expect(passages.at(-1)!.page).toBe(3);
    expect(passages.every((p) => p.text.length <= 1000 && !p.text.includes("--- page"))).toBe(true);
  });
});

let library: string;
beforeEach(() => {
  library = fs.mkdtempSync(path.join(os.tmpdir(), "npkn-search-"));
  process.env.NPKN_LIBRARY = library;
  process.env.NPKN_NO_EMBEDDINGS = "1";
  for (const key of ["__npknStore", "__npknSearch"]) delete (globalThis as Record<string, unknown>)[key];
});
afterEach(() => fs.rmSync(library, { recursive: true, force: true }));

const node = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ op: "addNode" as const, node: { id, kind: "idea" as const, x: 0, y: 0, text, origin: "user", createdAt: 1, ...extra } });

describe("search index", () => {
  it("finds items and document passages, follows edits, and searches across napkins", async () => {
    const store = await import("@/lib/napkin/store");
    const { saveAsset, saveText } = await import("@/lib/ingest/ingest");
    const { indexNapkin, search } = await import("../index");
    const a = await store.createNapkin("Forests");
    const b = await store.createNapkin("Cities");
    const assetId = await saveAsset(a.id, Buffer.from("pdf"), "book.pdf");
    await saveText(a.id, assetId, `--- page 1 ---\n\nIntro.\n\n--- page 2 ---\n\n${"Filler text. ".repeat(100)} The famous line: "the wood wide web is a market, not a commune." ${"More filler. ".repeat(100)}`);
    await store.applyToNapkin(a.id, [node("n-1", "Trees share sugar with fungi"), node("n-2", "A book", { kind: "doc", assetId, fileName: "book.pdf" })], "user");
    await store.applyToNapkin(b.id, [node("n-3", "Neighbourhood energy grids like fungal networks")], "user");
    await indexNapkin(a.id);
    await indexNapkin(b.id);

    const quote = await search("wood wide web market", { napkinIds: [a.id] });
    expect(quote[0]).toMatchObject({ nodeId: "n-2", page: 2 });
    expect(quote[0].snippet).toContain("market");

    const across = await search("fungal fungi", {});
    expect(new Set(across.map((h) => h.napkinId))).toEqual(new Set([a.id, b.id]));

    await store.applyToNapkin(a.id, [{ op: "updateNode", id: "n-1", patch: { text: "Mycelium trades minerals" } }], "user");
    await indexNapkin(a.id, ["n-1"]);
    expect((await search("mycelium", { napkinIds: [a.id] })).map((h) => h.nodeId)).toEqual(["n-1"]);
    expect(await search("sugar", { napkinIds: [a.id] })).toEqual([]);

    await store.applyToNapkin(a.id, [{ op: "removeNode", id: "n-2" }], "user");
    await indexNapkin(a.id, ["n-2"]);
    expect(await search("wood wide web", { napkinIds: [a.id] })).toEqual([]);
  });
});

const modelCached = fs.existsSync(path.join(os.homedir(), ".npkn", "models", "Xenova"));

describe.skipIf(!modelCached)("semantic search (local model)", () => {
  it("matches by meaning, through the embedding worker", async () => {
    process.env.NPKN_NO_EMBEDDINGS = "";
    const store = await import("@/lib/napkin/store");
    const { indexNapkin, search } = await import("../index");
    const a = await store.createNapkin("M");
    await store.applyToNapkin(a.id, [node("n-1", "Mushrooms link tree roots and trade nutrients underground"), node("n-2", "Quarterly pricing tiers for the SaaS plan")], "user");
    await indexNapkin(a.id);
    // Embedding happens in the background; give the worker time.
    for (let i = 0; i < 60; i++) {
      const hits = await search("fungal networks in forests", { napkinIds: [a.id] });
      if (hits[0]?.nodeId === "n-1") return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("no semantic match");
  }, 90_000);
});
