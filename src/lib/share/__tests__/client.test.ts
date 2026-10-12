// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ARTIFACT_CSP } from "@/lib/artifacts/artifacts";
import type { OpBatch } from "@/lib/mulch/types";
import { sandboxCsp } from "../../../../cloud/src/files";
import { ShareError, shareClient, thumbnailPath, type Share } from "../client";

type Call = { url: string; method: string; headers: Headers; body?: unknown };

function mockFetch(respond: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body };
    calls.push(call);
    const { status = 200, body = {} } = respond(call);
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const share: Share = { id: "abc", ownerToken: "secret", url: "https://share.mlch.app/s/abc/", manifestUrl: "https://share.mlch.app/api/shares/abc/manifest" };
const batch = (id: string): OpBatch => ({ id, mulchId: "m", ops: [], origin: "user", at: 1 });

describe("share client", () => {
  it("creates a share with the install id, at mlch.app by default", async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 201, body: share }));
    const client = shareClient({ install: "inst-1", fetch });
    expect(await client.create({ kind: "mulch", title: "Pricing" })).toEqual(share);
    expect(calls[0].url).toBe("https://mlch.app/api/shares");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("X-Mlch-Install")).toBe("inst-1");
    expect(JSON.parse(String(calls[0].body))).toEqual({ kind: "mulch", title: "Pricing" });
  });

  it("uses MLCH_SHARE_URL when set", async () => {
    process.env.MLCH_SHARE_URL = "http://localhost:8787/";
    try {
      expect(shareClient().base).toBe("http://localhost:8787");
    } finally {
      delete process.env.MLCH_SHARE_URL;
    }
  });

  it("sends the owner token and file sizes, with paths encoded", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: { path: "x", size: 3 } }));
    const client = shareClient({ fetch, base: "https://x.test" });
    await client.uploadFile(share, "assets/a b.png", new Uint8Array([1, 2, 3]));
    expect(calls[0].url).toBe("https://x.test/api/shares/abc/files/assets/a%20b.png");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer secret");
    expect(calls[0].headers.get("Content-Length")).toBe("3");
    await client.uploadSnapshot(share, { version: 1, id: "m", title: "t", createdAt: 1, updatedAt: 1, nodes: {}, edges: {}, groups: {} });
    await client.setLive(share, false);
    await client.remove(share);
    expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual([
      "PUT https://x.test/api/shares/abc/snapshot",
      "PUT https://x.test/api/shares/abc/live",
      "DELETE https://x.test/api/shares/abc",
    ]);
  });

  it("turns the server's refusal into a ShareError with its message", async () => {
    const { fetch } = mockFetch(() => ({ status: 413, body: { error: "A file can be at most 25 MB." } }));
    const error = await shareClient({ fetch }).uploadFile(share, "a.bin", new Uint8Array(1)).catch((e) => e);
    expect(error).toBeInstanceOf(ShareError);
    expect(error.status).toBe(413);
    expect(error.message).toBe("A file can be at most 25 MB.");
  });

  it("names deck previews the way the shared canvas looks for them", () => {
    expect(thumbnailPath("artifacts/deck.pptx")).toBe("thumbnails/artifacts/deck.pptx.png");
  });
});

describe("live sender", () => {
  it("sends batches in order, retrying failures", async () => {
    let failures = 1;
    const { fetch, calls } = mockFetch(() => (failures-- > 0 ? { status: 503 } : { body: { seq: 1 } }));
    const sender = shareClient({ fetch }).liveSender(share, { retryMs: [1] });
    sender.send(batch("b1"));
    sender.send(batch("b2"));
    await sender.flush();
    const sent = calls.map((c) => (JSON.parse(String(c.body)) as { batches: OpBatch[] }).batches.map((b) => b.id));
    expect(sent[0]).toEqual(["b1"]); // failed
    expect(sent.flat().slice(1)).toEqual(["b1", "b2"]);
    expect(sender.stopped).toBeUndefined();
  });

  it("stops for good when the share refuses (gone, not live, wrong token)", async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 409, body: { error: "Sharing is not live." } }));
    const sender = shareClient({ fetch }).liveSender(share, { retryMs: [1] });
    sender.send(batch("b1"));
    await sender.flush();
    sender.send(batch("b2"));
    await sender.flush();
    expect(calls).toHaveLength(1);
    expect(sender.stopped?.message).toBe("Sharing is not live.");
  });
});

describe("shared files' sandbox", () => {
  it("is the app's artifact sandbox, plus only the share's own files", () => {
    expect(sandboxCsp()).toBe(ARTIFACT_CSP);
    const own = sandboxCsp(["https://share.mlch.app/s/abc/"]);
    expect(own).toContain("img-src data: blob: https://share.mlch.app/s/abc/");
    expect(own.replaceAll(" https://share.mlch.app/s/abc/", "")).toBe(ARTIFACT_CSP);
  });
});
