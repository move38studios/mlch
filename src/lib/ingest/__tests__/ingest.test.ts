// @vitest-environment node
import { describe, expect, it } from "vitest";

describe("a page's preview picture", () => {
  it("comes from og:image or twitter:image, in either attribute order, made absolute", async () => {
    const { pageImage } = await import("../ingest");
    expect(pageImage('<head><meta property="og:image" content="/img/card.png"></head>', "https://example.com/a/b")).toBe("https://example.com/img/card.png");
    expect(pageImage('<meta content="https://cdn.x.com/p.jpg?a=1&amp;b=2" property="og:image" />', "https://x.com")).toBe("https://cdn.x.com/p.jpg?a=1&b=2");
    expect(pageImage('<meta name="twitter:image" content="http://x.com/t.png">', "https://x.com")).toBe("https://x.com/t.png");
    expect(pageImage("<meta name=\"description\" content=\"no picture\">", "https://x.com")).toBeUndefined();
    expect(pageImage('<meta property="og:image" content="javascript:alert(1)">', "https://x.com")).toBeUndefined();
  });
});
