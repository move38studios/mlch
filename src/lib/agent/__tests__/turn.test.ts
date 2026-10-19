import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mulch/store", () => ({ mulchDir: () => "/nonexistent-mlch-test" }));

import type { JobStatus } from "@/lib/mulch/events";
import type { Mulch } from "@/lib/mulch/types";
import { commentNow, lastTurnAt, yourTurn } from "../turn";

const mulch = {
  id: "m",
  title: "T",
  nodes: {
    a: { id: "a", kind: "idea", x: 0, y: 0, text: "Forest cities", origin: "user", createdAt: 1 },
    b: { id: "b", kind: "idea", x: 0, y: 0, text: "Cooler streets", origin: "ai", createdAt: 1 },
  },
  edges: {},
  groups: {},
  comments: {
    c1: { id: "c1", nodeId: "a", text: "shorter", createdAt: 10 },
    c2: { id: "c2", nodeId: "b", text: "source?", createdAt: 11 },
  },
} as unknown as Mulch;

describe("a comment acted on now", () => {
  it("goes by itself", () => {
    const turn = commentNow(mulch, "c2");
    expect(turn.commentIds).toEqual(["c2"]);
    expect(turn.block).toContain("source?");
    expect(turn.block).not.toContain("shorter");
  });

  it("is not the person's turn, and its comment stays out of their next one while it runs", async () => {
    const jobs = [
      { id: "j1", retry: { kind: "command", input: "go" }, queuedAt: 5 },
      { id: "j2", retry: { kind: "command", input: "source?", comment: "c2" }, queuedAt: 20 },
    ] as JobStatus[];
    expect(lastTurnAt(jobs)).toBe(5);
    const turn = await yourTurn(mulch, 5, new Set(["c2"]));
    expect(turn.commentIds).toEqual(["c1"]);
  });

  it("does nothing for a closed or missing comment", () => {
    expect(commentNow(mulch, "nope").block).toBe("");
    expect(commentNow({ ...mulch, comments: { c1: { ...mulch.comments!.c1, resolvedAt: 12 } } }, "c1").block).toBe("");
  });
});
