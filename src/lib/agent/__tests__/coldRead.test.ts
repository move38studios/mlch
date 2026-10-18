// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CLEAR, coldReadNote, readableText } from "../coldRead";

describe("the cold reader", () => {
  it("reads a deck slide by slide, a page as text, markdown as it is", () => {
    const deck = `<style>.x{}</style><section class="slide" data-slide="1"><h1>Loudbox</h1></section><section class="slide" data-slide="2"><p>How many of the 31</p></section>`;
    expect(readableText(deck, "artifacts/deck.html")).toBe("Slide 1: Loudbox\nSlide 2: How many of the 31");
    expect(readableText("<main><h1>Page</h1><p>Text</p></main>", "p.html")).toBe("Page Text");
    expect(readableText("# Doc\n\nText", "doc.md")).toBe("# Doc\n\nText");
  });

  it("turns its verdict into a note the writer acts on", () => {
    expect(coldReadNote(undefined)).toBe("");
    expect(coldReadNote(CLEAR)).toContain("a newcomer can follow it");
    const note = coldReadNote('1. Slide 2, "the 31": which 31?');
    expect(note).toContain("could not follow");
    expect(note).toContain("the 31");
  });
});
