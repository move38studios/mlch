// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { allowedManifest, filesOf, sharedMulch } from "../shares";

afterEach(() => {
  delete process.env.MLCH_SHARE_URL;
});

describe("sharing", () => {
  it("accepts manifests only from the share host", () => {
    expect(allowedManifest("https://share.mlch.app/api/shares/abc123/manifest")).toBe(true);
    expect(allowedManifest("https://mlch.app/api/shares/abc123/manifest")).toBe(true);
    expect(allowedManifest("https://evil.example/api/shares/abc123/manifest")).toBe(false);
    expect(allowedManifest("http://share.mlch.app/api/shares/abc123/manifest")).toBe(false);
    expect(allowedManifest("https://share.mlch.app/api/shares/abc/files/x")).toBe(false);
    process.env.MLCH_SHARE_URL = "http://localhost:8787";
    expect(allowedManifest("http://localhost:8787/api/shares/abc123/manifest")).toBe(true);
  });

  it("sends link cards as titles only, and lists each item's files", async () => {
    const base = { x: 0, y: 0, text: "", origin: "agent:x", createdAt: 1 };
    const mulch = {
      id: "m", title: "T", createdAt: 1, updatedAt: 1, edges: {}, groups: {},
      nodes: {
        a: { ...base, id: "a", kind: "ref" as const, title: "Pricing notes", ref: { sourceId: "vault01", path: "Private/Pricing.md" } },
        b: { ...base, id: "b", kind: "ref" as const, title: "Seat pricing", ref: { mulchId: "m2", itemId: "p1" } },
        d: { ...base, id: "d", kind: "ref" as const, ref: { mulchId: "m3", itemId: "p9" } },
        c: { ...base, id: "c", kind: "doc" as const, assetId: "ab12.pdf" },
      },
    };
    const shared = await sharedMulch(mulch as never, async () => "Taken when shared");
    expect(JSON.stringify(shared)).not.toContain("Private/Pricing.md");
    expect(JSON.stringify(shared)).not.toContain("m2");
    expect(shared.nodes.a.title).toBe("Pricing notes");
    expect(shared.nodes.b.ref).toEqual({ mulchId: "shared", itemId: "" });
    expect(shared.nodes.d.title).toBe("Taken when shared");
    expect(filesOf(mulch.nodes.c as never)).toEqual(["assets/ab12.pdf", "assets/ab12.md"]);
  });
});
