// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mulch, MulchNode, MulchOp } from "@/lib/mulch/types";
import { cardsText, copiedCards, pasteOps } from "../clipboard";

const node = (id: string, extra: Partial<MulchNode> = {}): MulchNode => ({ id, kind: "search", x: 0, y: 0, w: 100, h: 80, text: `text ${id}`, origin: "agent:j1", createdAt: 1, ...extra });
const mulch: Mulch = {
  version: 1,
  id: "m1",
  title: "t",
  createdAt: 1,
  updatedAt: 1,
  nodes: {
    a: node("a", { title: "A", groupId: "g1" }),
    b: node("b", { kind: "artifact", x: 200, docPath: "artifacts/deck.html", gen: { id: "g", endpoint: "e", status: "running", startedAt: 1 } }),
    c: node("c", { kind: "image", assetId: `${"f".repeat(64)}.png` }),
  },
  edges: {
    ab: { id: "ab", source: "a", target: "b", label: "made from", origin: "agent:j1", createdAt: 1 },
    ac: { id: "ac", source: "a", target: "c", origin: "user", createdAt: 1 },
  },
  groups: {},
};

afterEach(() => vi.unstubAllGlobals());

describe("copied cards", () => {
  it("carry the cards and the connections between them, and their text", () => {
    const cards = copiedCards(mulch, ["a", "b", "missing"])!;
    expect(cards.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(cards.edges.map((e) => e.id)).toEqual(["ab"]);
    expect(cardsText(cards)).toBe("A\ntext a\n\ntext b");
    expect(copiedCards(mulch, [])).toBeUndefined();
  });

  it("paste as the person's own new cards, files copied, connections kept", async () => {
    const fetch = vi.fn(async () => Response.json({ docPaths: { "artifacts/deck.html": "artifacts/deck-2.html" } }));
    vi.stubGlobal("fetch", fetch);
    const { ops, ids } = await pasteOps("m2", copiedCards(mulch, ["a", "b", "c"])!, { offset: { x: 40, y: 40 } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ from: "m1", assets: [`${"f".repeat(64)}.png`], docPaths: ["artifacts/deck.html"] });
    const added = ops.flatMap((op: MulchOp) => (op.op === "addNode" ? [op.node] : []));
    expect(added.map((n) => n.id)).toEqual(ids);
    expect(ids).not.toContain("a");
    expect(added[0]).toMatchObject({ x: 40, y: 40, origin: "user", userTouched: true, title: "A" });
    expect(added[0].groupId).toBeUndefined();
    expect(added[1]).toMatchObject({ docPath: "artifacts/deck-2.html" });
    expect(added[1].gen).toBeUndefined();
    const edges = ops.flatMap((op: MulchOp) => (op.op === "addEdge" ? [op.edge] : []));
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ source: ids[0], target: ids[1], label: "made from", origin: "user" });
  });

  it("paste centred on a point, and need no file copies for plain cards in the same mulch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { ops } = await pasteOps("m1", copiedCards(mulch, ["a", "c"])!, { center: { x: 1000, y: 1000 } });
    expect(fetch).not.toHaveBeenCalled();
    const added = ops.flatMap((op: MulchOp) => (op.op === "addNode" ? [op.node] : []));
    expect(added.map((n) => [n.x, n.y])).toEqual([[950, 960], [950, 960]]);
  });
});
