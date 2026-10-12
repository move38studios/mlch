import { describe, expect, it } from "vitest";
import { dropEcho, overlap } from "../echo";

const seg = (id: string, at: number, speaker: "me" | "them", text: string) => ({ id, at, speaker, text, source: "speech" as const });

describe("dropEcho", () => {
  it("drops the microphone's copy of what the others said, and keeps the person's own words", () => {
    const segments = [
      seg("t1", 10_000, "them", "We should charge per seat, twelve dollars a month."),
      seg("m1", 11_500, "me", "we should charge per seat twelve dollars a month"),
      seg("m2", 14_000, "me", "I disagree, per minute is simpler."),
      seg("m3", 60_000, "me", "We should charge per seat, twelve dollars a month."),
    ];
    expect(dropEcho(segments).map((s) => s.id)).toEqual(["t1", "m2", "m3"]);
  });

  it("measures overlap on the shorter text", () => {
    expect(overlap("per seat pricing", "we like per seat pricing a lot")).toBe(1);
    expect(overlap("", "anything")).toBe(0);
  });
});
