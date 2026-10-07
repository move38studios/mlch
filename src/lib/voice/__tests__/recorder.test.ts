import { describe, expect, it } from "vitest";
import { Chunker, downsample } from "../recorder";

/** Feed `ms` of speech or silence; return the decisions that were not "keep", with the time they happened. */
function run(chunker: Chunker, pattern: Array<[boolean, number]>) {
  const events: Array<[string, number]> = [];
  let t = 0;
  for (const [speaking, ms] of pattern) {
    for (let i = 0; i < ms / 20; i++) {
      t += 20;
      const decision = chunker.push(speaking);
      if (decision !== "keep") {
        events.push([decision, t]);
        if (decision === "cut") chunker.reset();
        else chunker.reset(300);
      }
    }
  }
  return events;
}

describe("Chunker", () => {
  it("cuts at a pause after a sentence", () => {
    expect(run(new Chunker(), [[true, 2000], [false, 1000]])).toEqual([["cut", 2660]]);
  });

  it("does not cut on a short breath mid-sentence", () => {
    expect(run(new Chunker(), [[true, 1000], [false, 300], [true, 1000]])).toEqual([]);
  });

  it("drops silence but keeps listening", () => {
    const events = run(new Chunker(), [[false, 3000]]);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(([d]) => d === "drop")).toBe(true);
  });

  it("drops a click without speech", () => {
    expect(run(new Chunker(), [[true, 100], [false, 600]]).map(([d]) => d)).toEqual(["drop"]);
  });

  it("cuts long speech at a short pause, and never later than 15s", () => {
    expect(run(new Chunker(), [[true, 9000], [false, 300]])).toEqual([["cut", 9260]]);
    expect(run(new Chunker(), [[true, 20000]])).toEqual([["cut", 15000]]);
  });
});

describe("downsample", () => {
  it("averages to the target rate", () => {
    const input = new Float32Array([1, 1, 1, 0, 0, 0]);
    expect(Array.from(downsample(input, 48000, 16000))).toEqual([1, 0]);
  });
});
