import { describe, expect, it } from "vitest";
import { PICKS, picksFor } from "../picks";

describe("fal picks", () => {
  it("has a quality and a fast pick for every task, quality first", () => {
    for (const [category, tiers] of Object.entries(PICKS)) {
      expect(tiers.quality.length, category).toBeGreaterThan(0);
      expect(tiers.fast.length, category).toBeGreaterThan(0);
      expect(picksFor(category)[0]).toMatchObject({ category, tier: "quality" });
    }
    expect(picksFor("text-to-3d")).toEqual([]);
    expect(picksFor().length).toBe(Object.values(PICKS).reduce((n, t) => n + t.quality.length + t.fast.length, 0));
  });
});
