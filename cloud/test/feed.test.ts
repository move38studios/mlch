import { describe, expect, it } from "vitest";
import { emptyFeed, withBatch, withSnapshot } from "../viewer/live";
import { batch, idea, mulch } from "./helpers";

const add = (seq: number) => batch(`b${seq}`, [{ op: "addNode", node: idea(`n${seq}`, `idea ${seq}`) }]);

describe("viewer feed", () => {
  it("holds batches until the snapshot, then applies only the ones after it, in order", () => {
    let feed = withBatch(emptyFeed, 3, add(3)).feed;
    feed = withBatch(feed, 2, add(2)).feed;
    expect(feed.mulch).toBeUndefined();
    const result = withSnapshot(feed, mulch({ n1: idea("n1", "one"), n2: idea("n2", "two") }), 2);
    expect(Object.keys(result.feed.mulch!.nodes).sort()).toEqual(["n1", "n2", "n3"]);
    expect(result.feed.seq).toBe(3);
    expect(result.added).toEqual(["n3"]);
    expect(result.gap).toBe(false);
  });

  it("skips batches it already has", () => {
    const start = withSnapshot(emptyFeed, mulch({ n1: idea("n1", "one") }), 1).feed;
    const again = withBatch(start, 1, add(1));
    expect(again.feed).toBe(start);
    expect(again.added).toEqual([]);
  });

  it("notices a missing batch", () => {
    const start = withSnapshot(emptyFeed, mulch(), 0).feed;
    const result = withBatch(start, 2, add(2));
    expect(result.gap).toBe(true);
    expect(result.feed.seq).toBe(0);
    const caughtUp = withBatch(result.feed, 1, add(1));
    expect(caughtUp.gap).toBe(false);
    expect(caughtUp.feed.seq).toBe(2);
    expect(caughtUp.added).toEqual(["n1", "n2"]);
  });
});
