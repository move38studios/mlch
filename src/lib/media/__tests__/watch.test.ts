// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEMINI_API_KEY;
});

describe("Gemini watching a local video", () => {
  it("uploads it, waits while it is processed, asks, and deletes it there", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "watch-")), "v.mp4");
    fs.writeFileSync(file, "fake video");
    const calls: string[] = [];
    let polls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${url.replace(/\?.*$/, "")}`);
      if (url.endsWith("/upload/v1beta/files")) return new Response("{}", { headers: { "x-goog-upload-url": "https://upload.example/u1" } });
      if (url === "https://upload.example/u1") return Response.json({ file: { name: "files/abc", uri: "https://g/files/abc", state: "PROCESSING" } });
      if (url.endsWith("/v1beta/files/abc") && (init.method ?? "GET") === "GET") return Response.json({ state: ++polls > 1 ? "ACTIVE" : "PROCESSING" });
      if (url.includes(":generateContent")) {
        expect(JSON.parse(init.body as string).contents[0].parts[0]).toEqual({ file_data: { mime_type: "video/mp4", file_uri: "https://g/files/abc" } });
        return Response.json({ candidates: [{ content: { parts: [{ text: "## Summary\nA teaser." }] } }] });
      }
      return new Response("{}");
    }));
    process.env.MLCH_GEMINI_POLL_MS = "1";
    const { geminiWatchFile } = await import("../watch");
    expect(await geminiWatchFile(file, "video/mp4")).toBe("## Summary\nA teaser.");
    expect(calls[0]).toBe("POST https://generativelanguage.googleapis.com/upload/v1beta/files");
    expect(calls).toContain("DELETE https://generativelanguage.googleapis.com/v1beta/files/abc");
  });

  it("says why when Gemini can't process it", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "watch-")), "v.mp4");
    fs.writeFileSync(file, "x");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/upload/v1beta/files")) return new Response("{}", { headers: { "x-goog-upload-url": "https://upload.example/u1" } });
      if (url === "https://upload.example/u1") return Response.json({ file: { name: "files/x", uri: "u", state: "FAILED" } });
      return Response.json({ error: { message: "Unsupported codec." } }, { status: 400 });
    }));
    const { geminiWatchFile } = await import("../watch");
    await expect(geminiWatchFile(file, "video/webm")).rejects.toThrow(/Unsupported codec/);
  });
});
