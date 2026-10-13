/**
 * What preview_artifact reports about a made file, from what the desktop app
 * measured while rendering it (electron/main.cjs renderArtifact). Each problem
 * says what is allowed, so the AI can fix it. Pure.
 */

import { SLIDE_HEIGHT, SLIDE_WIDTH } from "./deck";

export interface SlideMeasure {
  /** 1-based. */
  slide: number;
  /** Slides visible at once while this one was shown. */
  visible: number;
  overflow: { left: number; top: number; right: number; bottom: number } | null;
}

export interface DeckMeasure {
  /** Missing when the file has no deck player (a hand-made deck). */
  count?: number;
  expected?: number;
  /** Slides visible at once right after loading. */
  visibleAtLoad: number;
  slides: SlideMeasure[];
}

export interface PageShot {
  width: number;
  height: number;
  /** The page's full width; more than `width` means it scrolls sideways. */
  scrollWidth: number;
  scrollHeight: number;
  /** html or body hides overflow, so content below the window cannot be scrolled to. */
  clipped: boolean;
  smallText: { text: string; size: number }[];
}

export interface PageMeasure {
  shots: PageShot[];
}

export const PHONE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 800 };
export const MIN_TEXT_PX = 12;

const list = (numbers: number[]) => (numbers.length === 1 ? `${numbers[0]}` : `${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`);

export function deckProblems(measure: DeckMeasure): string[] {
  const problems: string[] = [];
  if (measure.count === undefined) {
    problems.push("This file has no deck player. Write decks with write_artifact kind \"deck\" and `slides` (one HTML string per slide); the player is added for you.");
    return problems;
  }
  if (measure.expected !== undefined && measure.count !== measure.expected) {
    problems.push(`The deck was written with ${measure.expected} slides but ${measure.count} were found: a slide's HTML has an unclosed tag or a stray </section>. Each slide must be complete, balanced HTML.`);
  }
  for (const s of measure.slides) {
    if (!s.overflow) continue;
    const { left, top, right, bottom } = s.overflow;
    const parts = [
      right > SLIDE_WIDTH ? `${right}px wide` : "",
      bottom > SLIDE_HEIGHT ? `${bottom}px down` : "",
      left < 0 ? `${-left}px past the left edge` : "",
      top < 0 ? `${-top}px above the top` : "",
    ].filter(Boolean);
    problems.push(`Slide ${s.slide}: content reaches ${parts.join(", ")}. A slide is ${SLIDE_WIDTH}×${SLIDE_HEIGHT}px and everything must fit inside it: shorten the text, reduce sizes or split it into two slides.`);
  }
  const doubled = measure.slides.filter((s) => s.visible > 1).map((s) => s.slide);
  if (measure.visibleAtLoad > 1 || doubled.length) {
    problems.push(
      `More than one slide was visible at once${doubled.length ? ` (on slide ${list(doubled)})` : " when the deck opened"}. Only the player shows and hides slides: do not set display, visibility, position or opacity on .slide or [data-slide] in the CSS; lay out an inner element instead.`,
    );
  }
  return problems;
}

export function pageProblems(measure: PageMeasure, html: string): string[] {
  const problems: string[] = [];
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) {
    problems.push('The page has no <meta name="viewport" content="width=device-width, initial-scale=1">; without it a phone shows the page shrunk to unreadable size. Add it in <head>.');
  }
  for (const shot of measure.shots) {
    const at = `At ${shot.width}px wide`;
    if (shot.scrollWidth > shot.width + 1) {
      problems.push(`${at} the page scrolls sideways (it is ${shot.scrollWidth}px wide). A page must fit every width down to ${PHONE.width}px: one column, max-width on text, images and tables at max-width: 100%, long words wrapped (overflow-wrap: anywhere), no fixed widths wider than the screen.`);
    }
    if (shot.clipped && shot.scrollHeight > shot.height + 1) {
      problems.push(`${at} the content is ${shot.scrollHeight}px tall but the page cannot scroll: html or body has overflow: hidden. A page must scroll normally; remove overflow: hidden (and fixed heights) from html and body.`);
    }
    if (shot.width <= PHONE.width && shot.smallText.length) {
      const samples = shot.smallText.slice(0, 4).map((t) => `"${t.text}" (${t.size}px)`).join(", ");
      problems.push(`${at} some text is smaller than ${MIN_TEXT_PX}px: ${samples}. Text must be at least ${MIN_TEXT_PX}px at phone width (body text 16px or more).`);
    }
  }
  return problems;
}
