import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { buildDeck, writtenArtifact, type DeckHandle } from "../deck";
import { artifactKindOf, withKindMeta } from "../kind";
import { deckProblems, pageProblems } from "../checks";

/** The deck in a document with its player running, at a window size. */
function open(html: string, { width = 1280, height = 720, hash = "" } = {}) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: `https://share.test/s/x/deck.html${hash}` });
  const { window } = dom;
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  window.dispatchEvent(new window.Event("resize"));
  const deck = (window as unknown as { __mlchDeck: DeckHandle }).__mlchDeck;
  const slides = Array.from(window.document.querySelectorAll<HTMLElement>("[data-slide]"));
  const shown = () => slides.filter((s) => window.getComputedStyle(s).display !== "none").map((s) => s.dataset.slide);
  const key = (key: string, init: KeyboardEventInit = {}) => window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  return { window, deck, slides, shown, key, stage: window.document.getElementById("mlch-deck")! };
}

const THREE = buildDeck({ title: "Squirrels <in> spring", slides: ["<h1>One</h1>", "<div class='split'><p>Two</p></div>", "<h1>Three</h1>"] });

describe("buildDeck", () => {
  it("makes one self-contained file that declares itself a deck", () => {
    expect(THREE.startsWith("<!doctype html>")).toBe(true);
    expect(THREE).toContain('<meta name="mlch:kind" content="deck">');
    expect(THREE).toContain("<title>Squirrels &#60;in&#62; spring</title>");
    expect(THREE).toContain('data-count="3"');
    expect(THREE).not.toMatch(/<(script|link)[^>]+(src|href)=/);
    expect(artifactKindOf(THREE)).toBe("deck");
  });

  it("keeps the deck's CSS from closing its style element", () => {
    const html = buildDeck({ title: "x", slides: ["a"], css: "h1{color:red}</style><script>alert(1)</script>" });
    expect(html).toContain("h1{color:red}<\\/style><script>alert(1)</script>");
    expect(html.match(/<\/style>/g)).toHaveLength(2);
  });

  it("shows exactly one slide, even when the deck's CSS shows them all", () => {
    const css = ".slide{display:block!important} .split{display:grid!important}";
    const { shown, deck } = open(buildDeck({ title: "x", slides: ["<h1>1</h1>", "<h1>2</h1>", "<h1>3</h1>"], css }));
    expect(deck.count).toBe(3);
    expect(shown()).toEqual(["1"]);
    deck.go(1);
    expect(shown()).toEqual(["2"]);
  });

  it("shows a slide the deck's CSS hides", () => {
    const { shown, slides, window } = open(buildDeck({ title: "x", slides: ["a", "b"], css: ".slide{display:none;visibility:hidden}" }));
    expect(shown()).toEqual(["1"]);
    expect(window.getComputedStyle(slides[0]).visibility).toBe("visible");
  });

  it("moves with the keys and stays within the deck", () => {
    const { deck, key, shown } = open(THREE);
    key("ArrowRight");
    expect(deck.index).toBe(1);
    key(" ");
    expect(deck.index).toBe(2);
    key("ArrowRight");
    expect(deck.index).toBe(2);
    key(" ", { shiftKey: true });
    expect(deck.index).toBe(1);
    key("Home");
    expect(deck.index).toBe(0);
    key("End");
    expect(deck.index).toBe(2);
    key("PageUp");
    expect(shown()).toEqual(["2"]);
    key("ArrowRight", { metaKey: true });
    expect(deck.index).toBe(1);
  });

  it("moves with a click on either half and a swipe", () => {
    const { deck, window } = open(THREE, { width: 1000 });
    window.document.body.dispatchEvent(new window.MouseEvent("click", { clientX: 800, bubbles: true }));
    expect(deck.index).toBe(1);
    window.document.body.dispatchEvent(new window.MouseEvent("click", { clientX: 100, bubbles: true }));
    expect(deck.index).toBe(0);
    const pointer = (type: string, x: number) => {
      const event = new window.MouseEvent(type, { clientX: x, clientY: 300, bubbles: true });
      Object.assign(event, { pointerType: "touch", pointerId: 7 });
      window.document.dispatchEvent(event);
    };
    pointer("pointerdown", 700);
    pointer("pointerup", 300);
    expect(deck.index).toBe(1);
    pointer("pointerdown", 300);
    pointer("pointerup", 700);
    expect(deck.index).toBe(0);
  });

  it("moves one slide per wheel gesture", () => {
    const { deck, window } = open(THREE);
    for (let i = 0; i < 10; i++) window.dispatchEvent(new window.WheelEvent("wheel", { deltaY: 30 }));
    expect(deck.index).toBe(1);
  });

  it("starts at the slide in the address and keeps it there", () => {
    const { deck, window } = open(THREE, { hash: "#3" });
    expect(deck.index).toBe(2);
    deck.go(0);
    expect(window.location.hash).toBe("#1");
  });

  it("scales the 1920x1080 stage to fit the window, centred", () => {
    const { stage } = open(THREE, { width: 390, height: 844 });
    const scale = 390 / 1920;
    expect(stage.style.getPropertyValue("width")).toBe("1920px");
    expect(stage.style.getPropertyValue("transform")).toBe(`translate(0px, ${(844 - 1080 * scale) / 2}px) scale(${scale})`);
    expect(stage.style.getPropertyPriority("transform")).toBe("important");
  });

  it("counts the slides it found against the ones it was built with", () => {
    const { deck } = open(buildDeck({ title: "x", slides: ["<div>open", "b", "c"] }));
    expect(deck.expected).toBe(3);
    expect(deck.count).toBe(3); // nested inside the unclosed div, still found
  });
});

describe("artifact kinds", () => {
  it("reads a declared kind, and recognises hand-made decks", () => {
    expect(artifactKindOf('<meta name="mlch:kind" content="page"><section class="slide"></section><script>onkeydown=1</script>')).toBe("page");
    expect(artifactKindOf('<section class="slide active"></section><script>document.addEventListener("keydown", f)</script>')).toBe("deck");
    expect(artifactKindOf("<h1>Table</h1>")).toBe("page");
    expect(artifactKindOf('<div class="slideshow"></div><script>keydown</script>')).toBe("page");
  });

  it("declares a kind in the head, after any doctype", () => {
    expect(withKindMeta("<!doctype html><html><head><title>t</title></head></html>", "page")).toBe('<!doctype html><html><head>\n<meta name="mlch:kind" content="page"><title>t</title></head></html>');
    expect(withKindMeta("<!DOCTYPE html><p>x</p>", "page")).toBe('<!DOCTYPE html>\n<meta name="mlch:kind" content="page"><p>x</p>');
    expect(withKindMeta('<head><meta name="mlch:kind" content="deck"></head>', "page")).toBe('<head><meta name="mlch:kind" content="page"></head>');
  });
});

describe("writtenArtifact", () => {
  it("builds decks from slides and declares pages", () => {
    const deck = writtenArtifact("D", "html", { kind: "deck", slides: ["a", "b"] });
    expect(deck).toMatchObject({ kind: "deck", slides: 2 });
    expect(writtenArtifact("D", "html", { slides: ["a"] })).toMatchObject({ kind: "deck" });
    const page = writtenArtifact("P", "html", { content: "<!doctype html><p>x</p>" });
    expect(page).toMatchObject({ kind: "page" });
    expect("content" in page && page.content).toContain('content="page"');
    expect(writtenArtifact("N", "md", { content: "# x" })).toEqual({ content: "# x" });
  });

  it("says what is allowed when the parts do not fit", () => {
    expect(writtenArtifact("D", "html", { kind: "deck", content: "<html>" })).toEqual({ problem: expect.stringContaining("A deck is written as `slides`") });
    expect(writtenArtifact("P", "html", { kind: "page", slides: ["a"] })).toEqual({ problem: expect.stringContaining("`slides` make a deck") });
    expect(writtenArtifact("P", "html", {})).toEqual({ problem: expect.stringContaining("A page is written whole in `content`") });
    expect(writtenArtifact("S", "svg", { kind: "deck", slides: ["a"] })).toEqual({ problem: expect.stringContaining("HTML only") });
  });
});

describe("preview problems", () => {
  it("reports slides that overflow and more than one slide at once", () => {
    const problems = deckProblems({
      count: 3,
      expected: 4,
      visibleAtLoad: 1,
      slides: [
        { slide: 1, visible: 1, overflow: null },
        { slide: 2, visible: 2, overflow: { left: 0, top: 0, right: 1920, bottom: 1400 } },
        { slide: 3, visible: 1, overflow: null },
      ],
    });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("written with 4 slides but 3 were found");
    expect(problems[1]).toBe("Slide 2: content reaches 1400px down. A slide is 1920×1080px and everything must fit inside it: shorten the text, reduce sizes or split it into two slides.");
    expect(problems[2]).toContain("(on slide 2)");
    expect(deckProblems({ count: 2, expected: 2, visibleAtLoad: 1, slides: [{ slide: 1, visible: 1, overflow: null }] })).toEqual([]);
    expect(deckProblems({ visibleAtLoad: 2, slides: [] })[0]).toContain("no deck player");
  });

  it("reports sideways scroll, a page that cannot scroll, small text on a phone and a missing viewport", () => {
    const shot = { width: 390, height: 844, scrollWidth: 390, scrollHeight: 2000, clipped: false, smallText: [] };
    const fine = '<meta name="viewport" content="width=device-width, initial-scale=1">';
    expect(pageProblems({ shots: [{ ...shot, width: 1280, height: 800 }, shot] }, fine)).toEqual([]);
    const problems = pageProblems({ shots: [{ ...shot, scrollWidth: 620, clipped: true, smallText: [{ text: "fine print", size: 10 }] }] }, "<p>x</p>");
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('<meta name="viewport"');
    expect(problems[1]).toContain("At 390px wide the page scrolls sideways (it is 620px wide)");
    expect(problems[2]).toContain("cannot scroll");
    expect(problems[3]).toContain('"fine print" (10px)');
  });
});
