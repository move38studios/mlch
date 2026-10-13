// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { allowedManifest, filesOf, findOwnShare, plainNote, sharedMulch } from "../shares";

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

  it("accepts manifests from the person's own server too", () => {
    expect(allowedManifest("https://mine.example/api/shares/abc123/manifest")).toBe(false);
    expect(allowedManifest("https://mine.example/api/shares/abc123/manifest", "https://mine.example")).toBe(true);
    expect(allowedManifest("https://other.example/api/shares/abc123/manifest", "https://mine.example")).toBe(false);
  });

  it("sends link cards as what they link to, as ordinary cards with their files", async () => {
    const base = { x: 0, y: 0, text: "", origin: "agent:x", createdAt: 1 };
    const mulch = {
      id: "m", title: "T", createdAt: 1, updatedAt: 1, edges: {}, groups: {},
      nodes: {
        a: { ...base, id: "a", kind: "ref" as const, x: 40, y: 50, title: "Pricing notes", ref: { sourceId: "vault01", path: "Private/Pricing.md" } },
        b: { ...base, id: "b", kind: "ref" as const, title: "Seat pricing", ref: { mulchId: "m2", itemId: "p1" } },
        d: { ...base, id: "d", kind: "ref" as const, title: "Gone", ref: { mulchId: "m3", itemId: "p9" } },
        c: { ...base, id: "c", kind: "doc" as const, assetId: "ab12.pdf" },
      },
    };
    const linkedOf = async (card: { id: string; x: number; y: number; ref?: { mulchId?: string } }) => {
      if (card.id === "a") return { node: { ...base, id: card.id, x: card.x, y: card.y, kind: "writeup" as const, title: "Pricing", text: "Seats at $12." }, files: [] };
      if (card.id === "b") return { node: { ...base, id: card.id, x: card.x, y: card.y, kind: "image" as const, assetId: "cd34.png" }, files: [{ from: "/lib/m2/assets/cd34.png", path: "assets/cd34.png" }] };
      return undefined;
    };
    const shared = await sharedMulch(mulch as never, linkedOf as never);
    const text = JSON.stringify(shared.mulch);
    expect(text).not.toContain("Private/Pricing.md");
    expect(text).not.toContain("m2");
    expect(shared.mulch.nodes.a).toMatchObject({ kind: "writeup", text: "Seats at $12.", x: 40, y: 50 });
    expect(shared.mulch.nodes.a.ref).toBeUndefined();
    expect(shared.mulch.nodes.b).toMatchObject({ kind: "image", assetId: "cd34.png" });
    expect(shared.files).toEqual([{ from: "/lib/m2/assets/cd34.png", path: "assets/cd34.png" }]);
    // A link that can't be read keeps only its title.
    expect(shared.mulch.nodes.d).toMatchObject({ kind: "ref", title: "Gone", ref: { mulchId: "shared", itemId: "" } });
    expect(filesOf(mulch.nodes.c as never)).toEqual(["assets/ab12.pdf", "assets/ab12.md"]);
  });

  it("knows its own shares, by server and share id", async () => {
    const library = await fs.mkdtemp(path.join(os.tmpdir(), "mlch-own-"));
    process.env.MLCH_LIBRARY = library;
    try {
      await fs.mkdir(path.join(library, "20261013-1200-aaaaaa"));
      const manifestUrl = "https://share.mlch.app/api/shares/abc123/manifest";
      await fs.writeFile(path.join(library, "20261013-1200-aaaaaa", "shares.json"), JSON.stringify([{ id: "abc123", ownerToken: "t", url: "https://share.mlch.app/s/abc123/", manifestUrl, kind: "mulch", createdAt: 1 }]));
      expect(await findOwnShare(manifestUrl)).toEqual({ mulchId: "20261013-1200-aaaaaa" });
      expect(await findOwnShare("https://share.mlch.app/api/shares/abc123/manifest/")).toEqual({ mulchId: "20261013-1200-aaaaaa" });
      expect(await findOwnShare("https://share.mlch.app/api/shares/zzz999/manifest")).toBeUndefined();
      expect(await findOwnShare("https://mine.example/api/shares/abc123/manifest")).toBeUndefined();
    } finally {
      delete process.env.MLCH_LIBRARY;
      await fs.rm(library, { recursive: true, force: true });
    }
  });

  it("keeps notes' words, not their HTML", () => {
    expect(plainNote('<p style="text-align: right;">One</p><p>Two&nbsp;&amp; three<br>four</p>')).toBe("One\nTwo & three\nfour\n");
    expect(plainNote("No *tags* here")).toBe("No *tags* here");
  });
});
