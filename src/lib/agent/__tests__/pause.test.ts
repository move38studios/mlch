// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, HarnessTurnParams } from "../types";

/** What each turn of the fake harness does: run until stopped (time ran out), use up its steps, or finish. */
const script: Array<"until-stopped" | "out-of-steps" | "finish"> = [];
const turns: HarnessTurnParams[] = [];
const cliFailed = vi.fn();

vi.mock("../server/cli", () => ({ cliFailed: (...args: unknown[]) => cliFailed(...args), prepareCli: async () => undefined }));
vi.mock("../server/harnesses", () => ({
  getHarness: () => ({
    id: "claude",
    getStatus: async () => ({ id: "claude", installed: true, signedIn: true, billing: "subscription", models: [] }),
    async *runTurn(params: HarnessTurnParams): AsyncGenerator<HarnessEvent> {
      turns.push(params);
      yield { type: "session", sessionId: params.sessionId ?? `s${turns.length}` };
      const step = script.shift() ?? "finish";
      if (step === "out-of-steps") yield { type: "error", code: "step_limit", message: "The agent stopped after reaching its step limit for one message." };
      // Like Claude Code: a stopped turn just ends.
      if (step === "until-stopped") await new Promise((resolve) => params.signal.addEventListener("abort", resolve, { once: true }));
    },
  }),
}));

let library: string;
beforeEach(() => {
  library = fs.mkdtempSync(path.join(os.tmpdir(), "mulch-pause-"));
  process.env.MLCH_LIBRARY = library;
  process.env.MLCH_NO_EMBEDDINGS = "1";
  process.env.MLCH_PERIOD_MS = "300";
  for (const key of ["__mlchStore", "__mlchSearch", "__mlchSources", "__mlchJobs"]) delete (globalThis as Record<string, unknown>)[key];
  script.length = 0;
  turns.length = 0;
  cliFailed.mockClear();
});
afterEach(() => {
  delete process.env.MLCH_PERIOD_MS;
  fs.rmSync(library, { recursive: true, force: true });
});

async function until<T>(read: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function setup() {
  const store = await import("@/lib/mulch/store");
  const jobs = await import("../jobs");
  const mulch = await store.createMulch("Pause");
  const state = (jobId: string, wanted: string) => until(async () => (await store.getJobs(mulch.id)).find((job) => job.id === jobId && job.state === wanted));
  return { store, jobs, mulch, state };
}

describe("instructions and long work run for a period", () => {
  it("pause when the period ends, and keep going resumes the same session", async () => {
    const { jobs, mulch, state } = await setup();
    script.push("until-stopped", "finish");
    const job = jobs.submitCommand(mulch.id, "Research everything about pricing");
    const paused = await state(job.id, "paused");
    expect(paused.session).toEqual({ id: "s1", harness: "claude" });
    expect(paused.error).toBeUndefined();
    expect(turns[0].maxSteps).toBeUndefined();
    expect(cliFailed).not.toHaveBeenCalled();

    const again = await jobs.continueJob(mulch.id, job.id);
    expect(again?.id).toBe(job.id);
    await state(job.id, "done");
    expect(turns[1].sessionId).toBe("s1");
    expect(turns[1].prompt).toMatch(/time ran out/);
    expect(turns[1].prompt).toContain("Research everything about pricing");
  });

  it("pause when the steps run out, without blaming the CLI", async () => {
    const { jobs, mulch, state } = await setup();
    script.push("out-of-steps");
    const job = jobs.submitCommand(mulch.id, "Do a lot");
    await state(job.id, "paused");
    expect(cliFailed).not.toHaveBeenCalled();
  });

  it("only paused jobs keep going", async () => {
    const { jobs, mulch, state } = await setup();
    const job = jobs.submitCommand(mulch.id, "Quick one");
    await state(job.id, "done");
    expect(await jobs.continueJob(mulch.id, job.id)).toBeUndefined();
  });
});
