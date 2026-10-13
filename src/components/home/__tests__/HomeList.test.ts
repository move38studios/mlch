import { describe, expect, it } from "vitest";
import { byWhen, recency, titleMatches } from "../HomeList";

const mulch = (id: string, updatedAt: number, openedAt?: number) => ({ id, title: id, createdAt: 0, updatedAt, nodeCount: 0, ...(openedAt ? { openedAt } : {}) });

describe("home list", () => {
  it("matches titles by word starts, in any order", () => {
    expect(titleMatches("Agency without losing aliveness", "alive agen")).toBe(true);
    expect(titleMatches("Agency without losing aliveness", "ency")).toBe(false);
    expect(titleMatches("Squirrel's morning", "morn")).toBe(true);
    expect(titleMatches("Anything", "")).toBe(false);
  });

  it("orders by last change or last opened, and groups by when", () => {
    const now = new Date(2026, 9, 13, 20, 0).getTime();
    const day = 24 * 60 * 60 * 1000;
    expect(recency(mulch("a", 1, 5))).toBe(5);
    const groups = byWhen([mulch("today", now - 60_000), mulch("opened", now - 30 * day, now - 3 * day), mulch("old", now - 30 * day)], now);
    expect(groups.map((g) => [g.label, g.mulches.map((m) => m.id)])).toEqual([
      ["Today", ["today"]],
      ["This week", ["opened"]],
      ["Earlier", ["old"]],
    ]);
  });
});
