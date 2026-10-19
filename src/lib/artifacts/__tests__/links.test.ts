import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { withLinks } from "../links";

function page(body: string) {
  const dom = new JSDOM(withLinks(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`), { runScripts: "dangerously", url: "http://127.0.0.1:3100/api/mulches/m/artifacts/deck.html" });
  const opened: string[] = [];
  dom.window.open = ((url: string) => {
    opened.push(url);
    return null;
  }) as typeof dom.window.open;
  const click = (selector: string) => {
    const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    dom.window.document.querySelector(selector)!.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { opened, click };
}

describe("links in made files", () => {
  it("opened on its own, opens web links to other sites in a new tab", () => {
    const { opened, click } = page(`<a id="w" href="https://en.wikipedia.org/wiki/Homeostat"><span id="inner">Homeostat</span></a>`);
    expect(click("#inner")).toBe(true);
    expect(opened).toEqual(["https://en.wikipedia.org/wiki/Homeostat"]);
  });

  it("in a frame, hands them to the page around it", () => {
    const dom = new JSDOM(`<iframe></iframe>`, { runScripts: "dangerously", url: "http://127.0.0.1:3100/n/m" });
    const got: unknown[] = [];
    dom.window.addEventListener("message", (event) => got.push(event.data));
    const inner = dom.window.document.querySelector("iframe")!.contentWindow!;
    inner.document.write(withLinks(`<a id="w" href="https://example.com/x">x</a>`));
    inner.document.close();
    inner.open = (() => {
      throw new Error("the file opened a window itself");
    }) as typeof inner.open;
    const event = new inner.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    inner.document.getElementById("w")!.dispatchEvent(event);
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(event.defaultPrevented).toBe(true);
      expect(got).toEqual([{ mlchOpenLink: "https://example.com/x" }]);
      resolve();
    }, 20));
  });

  it("leaves links within the file, its own files and other schemes alone", () => {
    const { opened, click } = page(`<a id="a" href="#part">x</a><a id="b" href="other.html">y</a><a id="c" href="mailto:a@b.c">z</a><a id="d" href="javascript:void 0">j</a>`);
    for (const id of ["#a", "#b", "#c", "#d"]) expect(click(id)).toBe(false);
    expect(opened).toEqual([]);
  });

  it("goes in once, into the head", () => {
    const once = withLinks("<html><head></head><body></body></html>");
    expect(withLinks(once)).toBe(once);
    expect(once.indexOf("data-mlch-links")).toBeLessThan(once.indexOf("</head>"));
    expect(withLinks("<p>bare</p>").startsWith("<script")).toBe(true);
  });
});
