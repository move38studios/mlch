import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { APEX, SHARE, auth, batch, call, create, idea, mulch, pushOps, putSnapshot, viewer } from "./helpers";

async function liveShare() {
  const share = await create({ kind: "mulch", title: "t" });
  await putSnapshot(share.id, share.ownerToken, mulch({ a: idea("a", "first") }));
  return share;
}

describe("live canvas", () => {
  it("needs the snapshot before changes, and the owner token", async () => {
    const share = await create({ kind: "mulch", title: "t" });
    expect((await pushOps(share.id, share.ownerToken, [batch("b1", [])])).status).toBe(409);
    await putSnapshot(share.id, share.ownerToken, mulch());
    expect((await pushOps(share.id, "wrong", [batch("b1", [])])).status).toBe(403);
    const malformed = await call(`${APEX}/api/shares/${share.id}/ops`, { method: "POST", headers: auth(share.ownerToken), body: JSON.stringify({ batches: [{ ops: [] }] }) });
    expect(malformed.status).toBe(400);
  });

  it("numbers batches, skips repeats, and passes them to viewers in order", async () => {
    const share = await liveShare();
    const watcher = await viewer(share.id);
    const [hello] = await watcher.next(1);
    expect(hello).toMatchObject({ type: "hello", live: true, seq: 0, snapshotSeq: 0 });

    const one = batch("b1", [{ op: "addNode", node: idea("b", "second") }]);
    const two = batch("b2", [{ op: "updateNode", id: "a", patch: { text: "first, edited" } }]);
    expect(await pushOps(share.id, share.ownerToken, [one, two]).then((r) => r.json())).toEqual({ seq: 2 });
    expect(await pushOps(share.id, share.ownerToken, [one]).then((r) => r.json())).toEqual({ seq: 2 }); // a retry
    const messages = await watcher.next(3);
    expect(messages.slice(1).map((m) => [m.type, m.seq, (m.batch as { id: string }).id])).toEqual([
      ["ops", 1, "b1"],
      ["ops", 2, "b2"],
    ]);
    watcher.close();
  });

  it("gives a late viewer the snapshot's seq and every batch after it", async () => {
    const share = await liveShare();
    await pushOps(share.id, share.ownerToken, [batch("b1", [{ op: "addNode", node: idea("b", "second") }]), batch("b2", [{ op: "removeNode", id: "a" }])]);
    const late = await viewer(share.id);
    const messages = await late.next(3);
    expect(messages[0]).toMatchObject({ type: "hello", seq: 2, snapshotSeq: 0 });
    expect(messages.slice(1).map((m) => m.seq)).toEqual([1, 2]);
    late.close();
  });

  it("folds batches into the snapshot, after which new viewers get no replay", async () => {
    const share = await liveShare();
    await pushOps(share.id, share.ownerToken, [batch("b1", [{ op: "addNode", node: idea("b", "second") }]), batch("b2", [{ op: "removeNode", id: "a" }])]);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(share.id));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const snapshot = await call(`${SHARE}/s/${share.id}/snapshot.json`);
    expect(snapshot.headers.get("X-Mlch-Seq")).toBe("2");
    const folded = await snapshot.json<{ nodes: Record<string, unknown> }>();
    expect(Object.keys(folded.nodes)).toEqual(["b"]);
    const fresh = await viewer(share.id);
    const [hello] = await fresh.next(1);
    expect(hello).toMatchObject({ type: "hello", seq: 2, snapshotSeq: 2 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fresh.messages).toHaveLength(1);
    fresh.close();
  });

  it("tells viewers when the owner replaces the canvas", async () => {
    const share = await liveShare();
    await pushOps(share.id, share.ownerToken, [batch("b1", [])]);
    const watcher = await viewer(share.id);
    await watcher.next(2);
    await putSnapshot(share.id, share.ownerToken, mulch());
    const messages = await watcher.next(3);
    expect(messages[2]).toEqual({ type: "snapshot", seq: 1 });
    watcher.close();
  });

  it("ends and restarts live sharing", async () => {
    const share = await liveShare();
    const watcher = await viewer(share.id);
    await watcher.next(1);
    const off = await call(`${APEX}/api/shares/${share.id}/live`, { method: "PUT", headers: auth(share.ownerToken), body: JSON.stringify({ live: false }) });
    expect(off.status).toBe(200);
    expect((await watcher.next(2))[1]).toEqual({ type: "live", live: false });
    expect((await pushOps(share.id, share.ownerToken, [batch("late", [])])).status).toBe(409);
    expect(await call(`${APEX}/api/shares/${share.id}/manifest`).then((r) => r.json<{ live: boolean }>())).toMatchObject({ live: false });
    await call(`${APEX}/api/shares/${share.id}/live`, { method: "PUT", headers: auth(share.ownerToken), body: JSON.stringify({ live: true }) });
    expect((await pushOps(share.id, share.ownerToken, [batch("again", [])])).status).toBe(200);
    watcher.close();
  });

  it("tells viewers when the share is deleted", async () => {
    const share = await liveShare();
    const watcher = await viewer(share.id);
    await watcher.next(1);
    await call(`${APEX}/api/shares/${share.id}`, { method: "DELETE", headers: auth(share.ownerToken) });
    expect((await watcher.next(2))[1]).toEqual({ type: "deleted" });
  });

  it("has no live feed for artifacts or unknown shares", async () => {
    const artifact = await create({ kind: "artifact", title: "Deck", entry: "deck.html" });
    expect((await call(`${SHARE}/s/${artifact.id}/live`, { headers: { Upgrade: "websocket" } })).status).toBe(404);
    expect((await call(`${SHARE}/s/${"B".repeat(24)}/live`, { headers: { Upgrade: "websocket" } })).status).toBe(404);
  });
});
