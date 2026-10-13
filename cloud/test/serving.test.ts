import { describe, expect, it } from "vitest";
import { SHARE, call, create, putFile, putSnapshot, mulch } from "./helpers";

function directives(csp: string | null): Record<string, string> {
  return Object.fromEntries((csp ?? "").split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...rest]) => [name, rest.join(" ")]));
}

describe("tab icon", () => {
  it("goes into a shared page's head, unless it has its own", async () => {
    const { withFavicon } = await import("../src/index");
    expect(withFavicon("<html><head><title>T</title></head></html>")).toMatch(/^<html><head><link rel="icon" type="image\/png" href="data:image\/png;base64,/);
    const own = '<head><link rel="icon" href="x.png"></head>';
    expect(withFavicon(own)).toBe(own);
  });
});

describe("shared artifacts", () => {
  it("serve the main file at the share's link, sandboxed with no network", async () => {
    const share = await create({ kind: "artifact", title: "Deck", entry: "deck.html" });
    await putFile(share.id, share.ownerToken, "deck.html", "<h1>Deck</h1><img src='img/a.png'>");
    await putFile(share.id, share.ownerToken, "img/a.png", "PNG");

    const bare = await call(`${SHARE}/s/${share.id}`);
    expect(bare.status).toBe(301);
    expect(bare.headers.get("Location")).toBe(`${SHARE}/s/${share.id}/`);

    // The link opens a frame page around the file: a page (no kind declared, no slides) fills it and scrolls.
    const frame = await call(share.url);
    expect(frame.status).toBe(200);
    const framed = await frame.text();
    expect(framed).toContain('<iframe src="deck.html" sandbox="allow-scripts" title="Deck">');
    expect(framed).toContain("<title>Deck</title>");
    expect(framed).toContain('<body class="page">');
    // Link previews: the title, and the mlch picture until the app uploads one.
    expect(framed).toContain('<meta property="og:title" content="Deck">');
    expect(framed).toContain(`<meta property="og:image" content="${SHARE}/brand/og.png">`);
    await putFile(share.id, share.ownerToken, "preview.png", "PNG");
    expect(await (await call(share.url)).text()).toContain(`<meta property="og:image" content="${SHARE}/s/${share.id}/preview.png">`);
    const frameCsp = directives(frame.headers.get("Content-Security-Policy"));
    expect(frameCsp["script-src"]).toMatch(/^'nonce-[A-Za-z0-9_-]+'$/);
    expect(frameCsp["frame-src"]).toBe("'self'");
    expect(frameCsp["frame-ancestors"]).toBe("'none'");

    const page = await call(`${share.url}deck.html`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await page.text();
    expect(html).toContain("<h1>Deck</h1>");
    expect(html.startsWith('<link rel="icon" type="image/png" href="data:image/png;base64,')).toBe(true); // the sandbox allows only data: images
    const csp = directives(page.headers.get("Content-Security-Policy"));
    expect(csp.sandbox).toBe("allow-scripts"); // opaque origin: no cookies, storage or same-origin access
    expect(csp["default-src"]).toBe("'none'");
    expect(csp["connect-src"]).toBe("'none'");
    expect(csp["form-action"]).toBe("'none'");
    expect(csp["frame-src"]).toBe("'none'");
    expect(csp["img-src"]).toBe(`data: blob: ${SHARE}/s/${share.id}/ ${SHARE}/api/mulches/${share.id}/`);
    expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const image = await call(`${share.url}img/a.png`);
    expect(await image.text()).toBe("PNG");
  });

  it("open a deck in a frame with Full screen, as its file declares", async () => {
    const { buildDeck } = await import("../../src/lib/artifacts/deck");
    const share = await create({ kind: "artifact", title: "Squirrels", entry: "squirrels.html" });
    await putFile(share.id, share.ownerToken, "squirrels.html", buildDeck({ title: "Squirrels", slides: ["<h1>One</h1>", "<h1>Two</h1>"] }));
    const framed = await (await call(share.url)).text();
    expect(framed).toContain('<body class="deck">');
    expect(framed).toContain("Full screen");
    expect(framed).toContain("document.fullscreenEnabled || document.webkitFullscreenEnabled");
  });

  it("download office files and show PDFs in the browser's own viewer", async () => {
    const deck = await create({ kind: "artifact", title: "Deck", entry: "deck.pptx" });
    await putFile(deck.id, deck.ownerToken, "deck.pptx", "PK");
    const pptx = await call(deck.url);
    expect(pptx.headers.get("Content-Disposition")).toBe('attachment; filename="deck.pptx"');

    const doc = await create({ kind: "artifact", title: "Doc", entry: "doc.pdf" });
    await putFile(doc.id, doc.ownerToken, "doc.pdf", "%PDF");
    const pdf = await call(doc.url);
    expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
    expect(pdf.headers.get("Content-Security-Policy")).toBeNull();
    expect(pdf.headers.get("Content-Disposition")).toBeNull();
  });

  it("serve every file as its name says, never as the uploader says", async () => {
    const share = await create({ kind: "artifact", title: "x", entry: "notes.txt" });
    await putFile(share.id, share.ownerToken, "notes.txt", "<script>alert(1)</script>");
    const response = await call(share.url);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });
});

describe("shared canvases", () => {
  it("open the viewer, locked down to its own origin", async () => {
    const share = await create({ kind: "mulch", title: "t" });
    await putSnapshot(share.id, share.ownerToken, mulch());
    const page = await call(share.url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="root"');
    expect(html).toContain("<title>Pricing ideas</title>"); // the canvas's own title, from its snapshot
    expect(html).toContain('<meta property="og:description" content="A canvas shared from mlch.">');
    const csp = directives(page.headers.get("Content-Security-Policy"));
    expect(csp["script-src"]).toBe("'self'");
    expect(csp["connect-src"]).toBe("'self' wss://share.mlch.test");
    expect(csp["frame-ancestors"]).toBe("'none'");
    const script = (await call(share.url).then((r) => r.text())).match(/src="(\/viewer\/assets\/[^"]+\.js)"/)?.[1];
    expect(script).toBeTruthy();
    expect((await call(`${SHARE}${script}`)).status).toBe(200);
  });

  it("are not found once unknown", async () => {
    expect((await call(`${SHARE}/s/${"C".repeat(24)}/`)).status).toBe(404);
    expect((await call(`${SHARE}/s/short/`)).status).toBe(404);
  });
});
