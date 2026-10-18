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
      if (step === "until-stopped" && !params.signal.aborted) await new Promise((resolve) => params.signal.addEventListener("abort", resolve, { once: true }));
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

describe("instructions and long work run side by side", () => {
  it("up to 10 in one mulch, and the cap across mulches; more wait, and start as others finish", { timeout: 20_000 }, async () => {
    const { store, jobs, mulch } = await setup();
    process.env.MLCH_PERIOD_MS = "60000";
    process.env.MLCH_WORK_TOTAL = "12";
    try {
      const other = await store.createMulch("Other");
      for (let i = 0; i < 20; i++) script.push("until-stopped");
      const here = Array.from({ length: 11 }, (_, i) => jobs.submitCommand(mulch.id, `Thing ${i}`));
      const there = Array.from({ length: 3 }, (_, i) => jobs.submitCommand(other.id, `Other ${i}`));
      const states = async (id: string) => (await store.getJobs(id)).filter((job) => job.retry).map((job) => job.state);
      await until(async () => (await states(mulch.id)).filter((s) => s === "running").length === 10 || undefined);
      expect((await states(mulch.id)).filter((s) => s === "queued")).toHaveLength(1);
      // 10 here and 2 there make 12, the cap in all.
      await until(async () => (await states(other.id)).filter((s) => s === "running").length === 2 || undefined);
      expect((await states(other.id)).filter((s) => s === "queued")).toHaveLength(1);
      // One stops: a waiting one starts (here or there).
      jobs.cancelJob(mulch.id, here[0].id);
      await until(async () => [...(await states(mulch.id)), ...(await states(other.id))].filter((s) => s === "queued").length === 1 || undefined);
      jobs.cancelJobs(mulch.id);
      jobs.cancelJobs(other.id);
      void there;
    } finally {
      delete process.env.MLCH_WORK_TOTAL;
    }
  });

  it("an instruction given with cards selected is about them", async () => {
    const { store, jobs, mulch, state } = await setup();
    await store.applyToMulch(mulch.id, [{ op: "addNode", node: { id: "n-a", kind: "idea", x: 0, y: 0, text: "Pricing per seat", origin: "user", createdAt: 1 } }], "user");
    const job = jobs.submitCommand(mulch.id, "Find counterarguments", { about: ["n-a", "gone"] });
    await state(job.id, "done");
    expect(turns.find((turn) => turn.prompt.includes("Find counterarguments"))?.prompt).toMatch(/<selected>[\s\S]*n-a \[idea\][\s\S]*Pricing per seat[\s\S]*<\/selected>/);
    expect((await store.getJobs(mulch.id)).find((j) => j.id === job.id)?.retry?.near).toEqual(["n-a", "gone"]);
  });
});
