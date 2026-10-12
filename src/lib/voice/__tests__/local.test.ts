// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ requests: [] as Array<[string, Record<string, unknown>]>, segments: [] as unknown[], submitted: [] as unknown[], heard: [] as string[] }));

vi.mock("@/lib/desktop/server", () => ({
  isDesktop: () => true,
  desktopRequest: async (type: string, payload: Record<string, unknown>) => {
    calls.requests.push([type, payload]);
    if (payload.action === "tap-start") return { ok: true, value: { session: payload.session } };
    if (payload.action === "status") return { ok: true, value: { installed: true, model: "missing" } };
    return { ok: true, value: {} };
  },
}));
vi.mock("@/lib/mulch/store", () => ({
  openMulch: async () => ({ transcript: [{ text: "earlier words" }] }),
  appendTranscript: async (_id: string, segment: unknown) => void calls.segments.push(segment),
}));
vi.mock("@/lib/agent/jobs", () => ({ submitInput: (_id: string, segment: unknown) => void calls.submitted.push(segment) }));
vi.mock("../transcriber", () => ({
  getTranscriber: async () => ({
    id: "fake",
    available: () => true,
    transcribe: async (audio: Blob, options: { prompt?: string }) => {
      calls.heard.push(options.prompt ?? "");
      return (await audio.text()).includes("silence") ? "" : "they said this";
    },
  }),
}));

import { __receiveForTests as receive, __stateForTests as state, downloadModel, localStatus, micSpeaker, startSystemAudio, stopSystemAudio, systemAudioFor } from "../local";

function chunkFile(content: string): string {
  const dir = path.join(os.tmpdir(), "mlch-audio", "test");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.wav`);
  fs.writeFileSync(file, content);
  return file;
}

describe("system audio", () => {
  beforeEach(() => {
    calls.requests.length = 0;
    calls.segments.length = 0;
    calls.submitted.length = 0;
    state().sessions.clear();
  });

  it("turns a capture's chunks into speech from them, in order, and removes the files", async () => {
    const capture = await startSystemAudio("m1", "us.zoom.xos");
    expect(calls.requests[0]).toEqual(["audio", { action: "tap-start", target: "us.zoom.xos", session: capture.session }]);
    expect(micSpeaker("m1")).toBe("me");
    expect(micSpeaker("other")).toBeUndefined();

    const first = chunkFile("speech one");
    const quiet = chunkFile("silence");
    await receive({ event: "chunk", session: capture.session, path: first, at: 1000 });
    await receive({ event: "chunk", session: capture.session, path: quiet, at: 2000 });
    await receive({ event: "tap-level", session: capture.session, peak: 0.4 });
    expect(systemAudioFor("m1")?.peak).toBe(0.4);
    await stopSystemAudio("m1");

    expect(calls.segments).toEqual([expect.objectContaining({ at: 1000, text: "they said this", source: "speech", speaker: "them" })]);
    expect(calls.submitted).toHaveLength(1);
    expect(calls.heard[0]).toBe("earlier words");
    expect(fs.existsSync(first) || fs.existsSync(quiet)).toBe(false);
    expect(systemAudioFor("m1")).toBeUndefined();
    expect(micSpeaker("m1")).toBeUndefined();
  });

  it("ignores chunk paths outside the helper's folder and chunks of unknown captures", async () => {
    const outside = path.join(os.tmpdir(), "elsewhere.wav");
    fs.writeFileSync(outside, "x");
    await receive({ event: "chunk", session: "nope", path: outside });
    expect(fs.existsSync(outside)).toBe(true);
    fs.rmSync(outside);
    const stray = chunkFile("speech");
    await receive({ event: "chunk", session: "nope", path: stray });
    expect(fs.existsSync(stray)).toBe(false);
    expect(calls.segments).toHaveLength(0);
  });

  it("forgets a capture the helper ended, keeping the reason", async () => {
    const capture = await startSystemAudio("m2");
    await receive({ event: "tap-ended", session: capture.session, error: "The audio helper stopped." });
    expect(systemAudioFor("m2")).toBeUndefined();
  });
});

describe("local model", () => {
  it("reports download progress until it is ready", async () => {
    expect((await localStatus()).model).toBe("missing");
    expect((await downloadModel()).model).toBe("downloading");
    await receive({ event: "model-progress", fraction: 0.5, phase: "downloading" });
    expect(await localStatus()).toEqual({ installed: true, model: "downloading", progress: 0.5 });
    await receive({ event: "model-ready" });
    expect(state().model).toBe("present");
  });
});
