// @vitest-environment node
import { describe, expect, it } from "vitest";
import { atLeast, installCandidates, managedCli, parseVersion } from "../cli";

describe("CLI choice", () => {
  it("compares versions the way the CLIs print them", () => {
    expect(parseVersion("2.1.296 (Claude Code)")).toEqual([2, 1, 296]);
    expect(parseVersion("codex-cli 0.160.1")).toEqual([0, 160, 1]);
    expect(atLeast("2.1.296", "2.1.286")).toBe(true);
    expect(atLeast("2.1.286", "2.1.286")).toBe(true);
    expect(atLeast("2.0.999", "2.1.0")).toBe(false);
    expect(atLeast("0.160.1", "0.157.0")).toBe(true);
    expect(atLeast("garbage", "0.1.0")).toBe(false);
  });

  it("looks where installs live, not only on the (Finder-less) PATH", () => {
    const candidates = installCandidates("claude", { PATH: "/usr/bin:/bin" }, "/Users/someone");
    expect(candidates).toEqual(expect.arrayContaining(["/Users/someone/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude"]));
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("stays out of the way in development (no cli.json)", () => {
    expect(managedCli("claude")).toBeUndefined();
  });
});
