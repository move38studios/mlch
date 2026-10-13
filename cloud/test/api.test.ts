import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { APEX, SHARE, auth, call, create, mulch, putFile, putSnapshot } from "./helpers";

describe("landing", () => {
  it("serves the landing canvas with its preview tags, and Download", async () => {
    const response = await call(`${APEX}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>mlch</title>");
    expect(html).toContain('property="og:image" content="https://mlch.app/brand/og-site.png"');
    expect(html).toMatch(/<script type="module"[^>]*src="\/viewer\/assets\/landing-[^"]+\.js"/);
    expect((await call(`${APEX}/brand/og-site.png`)).status).toBe(200);
    // The canvas's picture card (the logo) loads from the address image cards use.
    const logo = await call(`${APEX}/api/mulches/landing/assets/icon.svg`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("Content-Type")).toMatch(/svg/);
    const download = await call(`${APEX}/download`);
    expect(download.status).toBe(302);
    expect(download.headers.get("Location")).toMatch(/\/releases\/mac\/mlch\.dmg$/);
  });

  it("sends www to the apex", async () => {
    const response = await call("https://www.mlch.test/x?y=1");
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(`${APEX}/x?y=1`);
  });

  it("serves app updates from releases/mac in the bucket", async () => {
    await env.SHARES.put("releases/mac/latest-mac.yml", "version: 0.2.0\n");
    const feed = await call(`${APEX}/releases/mac/latest-mac.yml`);
    expect(feed.status).toBe(200);
    expect(feed.headers.get("Cache-Control")).toBe("no-cache");
    expect(await feed.text()).toBe("version: 0.2.0\n");
    expect((await call(`${APEX}/releases/mac/missing.zip`)).status).toBe(404);
    expect((await call(`${APEX}/releases/mac/..%2Fshares`)).status).toBe(404);
  });

  it("answers unknown paths with 404", async () => {
    expect((await call(`${APEX}/nope`)).status).toBe(404);
  });
});

describe("creating shares", () => {
  it("gives a long random id, an owner token and a link on the share host", async () => {
    const share = await create({ kind: "mulch", title: "Pricing ideas" });
    expect(share.id).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(share.ownerToken).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(share.url).toBe(`${SHARE}/s/${share.id}/`);
    const other = await create({ kind: "mulch", title: "x" });
    expect(other.id).not.toBe(share.id);
  });

  it("says what is wrong with a bad request", async () => {
    const bad = await call(`${APEX}/api/shares`, { method: "POST", body: JSON.stringify({ kind: "board" }) });
    expect(bad.status).toBe(400);
    expect((await bad.json<{ error: string }>()).error).toContain("artifact");
    const noEntry = await call(`${APEX}/api/shares`, { method: "POST", body: JSON.stringify({ kind: "artifact", title: "Deck" }) });
    expect(noEntry.status).toBe(400);
    const escape = await call(`${APEX}/api/shares`, { method: "POST", body: JSON.stringify({ kind: "artifact", entry: "../x.html" }) });
    expect(escape.status).toBe(400);
  });

  it("limits how many shares one install makes per hour", async () => {
    for (let i = 0; i < 60; i++) await create({ kind: "mulch", title: `n${i}` }, "busy-install");
    const response = await call(`${APEX}/api/shares`, {
      method: "POST",
      headers: { "X-Mlch-Install": "busy-install" },
      body: JSON.stringify({ kind: "mulch", title: "one too many" }),
    });
    expect(response.status).toBe(429);
    await create({ kind: "mulch", title: "another install" }, "quiet-install");
  });
});

describe("files", () => {
  it("takes files only with the owner token", async () => {
    const share = await create({ kind: "mulch", title: "t" });
    expect((await putFile(share.id, "wrong", "assets/a.png", "png")).status).toBe(403);
    const none = await call(`${APEX}/api/shares/${share.id}/files/assets/a.png`, { method: "PUT", headers: { "Content-Length": "3" }, body: "png" });
    expect(none.status).toBe(403);
    expect((await putFile(share.id, share.ownerToken, "assets/a.png", "png")).status).toBe(200);
  });

  it("refuses odd paths and unknown shares", async () => {
    const share = await create({ kind: "mulch", title: "t" });
    expect((await putFile(share.id, share.ownerToken, ".hidden/x", "x")).status).toBe(400);
    expect((await putFile(share.id, share.ownerToken, "a%2F..%2Fb", "x")).status).toBe(400);
    expect((await putFile("A".repeat(24), share.ownerToken, "x.txt", "x")).status).toBe(404);
  });

  it("refuses a file over 25 MB", async () => {
    const share = await create({ kind: "mulch", title: "t" });
    const response = await putFile(share.id, share.ownerToken, "assets/big.bin", new Uint8Array(25_000_001));
    expect(response.status).toBe(413);
    expect((await call(`${APEX}/api/shares/${share.id}/manifest`).then((r) => r.json<{ files: unknown[] }>())).files).toEqual([]);
  });

  it("refuses to go past 300 MB in all, counting a replaced file once", async () => {
    const share = await create({ kind: "mulch", title: "t" });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(share.id));
    await runInDurableObject(stub, async (room) => {
      for (let i = 0; i < 12; i++) expect((await room.reserveFile(share.ownerToken, `f${i}.bin`, 25_000_000)).ok).toBe(true);
      expect((await room.reserveFile(share.ownerToken, "f0.bin", 25_000_000)).ok).toBe(true); // replacing
      const over = await room.reserveFile(share.ownerToken, "f12.bin", 1);
      expect(over.ok ? 0 : over.status).toBe(413);
    });
  });

  it("serves files from the share host, sandboxed, and sends the apex there", async () => {
    const share = await create({ kind: "mulch", title: "t" });
    await putFile(share.id, share.ownerToken, "assets/pic.png", "PNG!");
    const file = await call(`${SHARE}/api/mulches/${share.id}/assets/pic.png`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("PNG!");
    expect(file.headers.get("Content-Type")).toBe("image/png");
    expect(file.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
    const same = await call(`${SHARE}/s/${share.id}/assets/pic.png`);
    expect(await same.text()).toBe("PNG!");
    const apex = await call(`${APEX}/s/${share.id}/assets/pic.png`);
    expect(apex.status).toBe(301);
    expect(apex.headers.get("Location")).toBe(`${SHARE}/s/${share.id}/assets/pic.png`);
    expect((await call(`${SHARE}/s/${share.id}/assets/missing.png`)).status).toBe(404);
    expect((await call(`${SHARE}/s/${share.id}/assets/pic.png`, { method: "POST" })).status).toBe(405);
  });

  it("serves deck previews where the app's cards look for them", async () => {
    const share = await create({ kind: "mulch", title: "t" });
    await putFile(share.id, share.ownerToken, "thumbnails/artifacts/deck.pptx.png", "thumb");
    const thumb = await call(`${SHARE}/api/mulches/${share.id}/thumbnail?doc=${encodeURIComponent("artifacts/deck.pptx")}&v=3`);
    expect(await thumb.text()).toBe("thumb");
  });
});

describe("manifest and delete", () => {
  it("lists what a share holds, for Open in mlch", async () => {
    const share = await create({ kind: "mulch", title: "Pricing ideas" });
    await putFile(share.id, share.ownerToken, "assets/a b.png", "12345");
    let manifest = await call(`${APEX}/api/shares/${share.id}/manifest`).then((r) => r.json<Record<string, unknown>>());
    expect(manifest).toMatchObject({ id: share.id, kind: "mulch", title: "Pricing ideas", live: true, seq: 0, url: share.url });
    expect(manifest.snapshotUrl).toBeUndefined();
    expect(manifest.files).toEqual([{ path: "assets/a b.png", size: 5, url: `${share.url}assets/a%20b.png` }]);
    await putSnapshot(share.id, share.ownerToken, mulch());
    manifest = await call(`${SHARE}/api/shares/${share.id}/manifest`).then((r) => r.json<Record<string, unknown>>());
    expect(manifest.snapshotUrl).toBe(`${share.url}snapshot.json`);
  });

  it("deletes everything, only for the owner", async () => {
    const share = await create({ kind: "mulch", title: "t" });
    await putFile(share.id, share.ownerToken, "assets/a.png", "x");
    await putSnapshot(share.id, share.ownerToken, mulch());
    expect((await call(`${APEX}/api/shares/${share.id}`, { method: "DELETE", headers: auth("nope") })).status).toBe(403);
    expect((await call(`${APEX}/api/shares/${share.id}`, { method: "DELETE", headers: auth(share.ownerToken) })).status).toBe(200);
    expect((await call(`${APEX}/api/shares/${share.id}/manifest`)).status).toBe(404);
    expect((await call(`${SHARE}/s/${share.id}/assets/a.png`)).status).toBe(404);
    expect((await call(`${SHARE}/s/${share.id}/snapshot.json`)).status).toBe(404);
    expect((await call(`${SHARE}/s/${share.id}/`)).status).toBe(404);
    expect(await env.SHARES.list({ prefix: `shares/${share.id}/` }).then((page) => page.objects.length)).toBe(0);
  });
});

describe("snapshots", () => {
  it("must be a mulch", async () => {
    const share = await create({ kind: "mulch", title: "t" });
    const bad = await call(`${APEX}/api/shares/${share.id}/snapshot`, { method: "PUT", headers: auth(share.ownerToken), body: "{}" });
    expect(bad.status).toBe(400);
    const artifact = await create({ kind: "artifact", title: "Deck", entry: "deck.html" });
    expect((await putSnapshot(artifact.id, artifact.ownerToken, mulch())).status).toBe(400);
  });

  it("is served with the seq it holds, and takes the canvas title", async () => {
    const share = await create({ kind: "mulch", title: "old" });
    expect(await putSnapshot(share.id, share.ownerToken, mulch()).then((r) => r.json())).toEqual({ seq: 0 });
    const snapshot = await call(`${SHARE}/s/${share.id}/snapshot.json`);
    expect(snapshot.headers.get("X-Mlch-Seq")).toBe("0");
    expect(await snapshot.json()).toMatchObject({ title: "Pricing ideas" });
    expect(await call(`${APEX}/api/shares/${share.id}/manifest`).then((r) => r.json<{ title: string }>())).toMatchObject({ title: "Pricing ideas" });
  });
});
