/**
 * HTML decks. The AI writes only the slides (and, optionally, CSS for their
 * look); this builds one self-contained file around them with a small player:
 * fixed 1920×1080 slides scaled to fit any window, centred and letterboxed,
 * exactly one shown at a time. It moves with the keys (←/→, space, Page Up/Down,
 * Home/End), a click on the right or left half, the wheel or trackpad, and a
 * swipe; `#n` in the address is slide n. `window.__mlchDeck` lets the preview
 * step through and check every slide.
 *
 * The player has no look of its own (no fonts or colours beyond a neutral
 * letterbox and a small counter): that comes from the house style through the
 * AI's CSS. It needs nothing from outside, so it works under the artifact
 * sandbox, in a shared link and opened from Finder. Pure: no Node imports.
 */

import { withKindMeta, type ArtifactKind } from "./kind";

export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;
export const MAX_SLIDES = 80;

export interface DeckInput {
  title: string;
  /** Each slide's HTML; it goes inside a 1920×1080 `<section class="slide">`. */
  slides: string[];
  /** The deck's look. Applied after the player's few rules. */
  css?: string;
}

/** What `window.__mlchDeck` offers (index and go are 0-based; the address and counter count from 1). */
export interface DeckHandle {
  readonly count: number;
  /** Slides the file was built with; fewer found means a slide's HTML broke the structure (an unclosed tag). */
  readonly expected: number;
  readonly index: number;
  go(n: number): void;
  /** How far the current slide's content reaches beyond 1920×1080, or null when it fits. */
  overflow(): { slide: number; left: number; top: number; right: number; bottom: number } | null;
}

const escapeText = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Text that would end the element it sits in. */
const safeStyle = (css: string) => css.replace(/<\/(style)/gi, "<\\/$1");

/**
 * The player's own rules: layout only. `:where()` keeps the letterbox and slide
 * colours below anything the deck's CSS says.
 */
const PLAYER_CSS = `html, body { margin: 0; height: 100%; overflow: hidden; touch-action: pinch-zoom; -webkit-text-size-adjust: 100%; }
:where(html) { background: #000; }
:where(.slide) { background: #fff; color: #000; }
#mlch-counter { position: fixed; right: 12px; bottom: 10px; z-index: 2147483647; pointer-events: none; font: 12px/1 system-ui, -apple-system, sans-serif; font-variant-numeric: tabular-nums; color: rgba(128, 128, 128, 0.85); }`;

/**
 * Runs in the deck. Layout that decides what is seen is set inline with
 * !important, so no rule in the deck's CSS can show two slides at once.
 */
const PLAYER_JS = `(function () {
  var W = ${SLIDE_WIDTH}, H = ${SLIDE_HEIGHT};
  // A deck built here has its stage; one made by the maker in mlch's format: the slides' own container.
  var stage = document.getElementById("mlch-deck") || (document.querySelector("[data-slide]") || {}).parentElement;
  var counter = document.getElementById("mlch-counter");
  if (!stage) return;
  var slides = Array.prototype.slice.call(stage.querySelectorAll("[data-slide]"));
  var expected = Number(stage.getAttribute("data-count")) || slides.length;
  var still = /[?&]still(=|&|$)/.test(location.search);
  var index = 0;
  var ownBars = window.getComputedStyle(document.documentElement).backgroundColor === "rgb(0, 0, 0)";
  function fix(el, prop, value) { el.style.setProperty(prop, value, "important"); }
  [["position", "fixed"], ["left", "0"], ["top", "0"], ["width", W + "px"], ["height", H + "px"], ["margin", "0"], ["padding", "0"], ["overflow", "hidden"], ["transform-origin", "0 0"], ["display", "block"]].forEach(function (p) { fix(stage, p[0], p[1]); });
  slides.forEach(function (s) {
    [["position", "absolute"], ["left", "0"], ["top", "0"], ["width", W + "px"], ["height", H + "px"], ["margin", "0"], ["overflow", "hidden"], ["box-sizing", "border-box"]].forEach(function (p) { fix(s, p[0], p[1]); });
  });
  function fit() {
    var vw = window.innerWidth || document.documentElement.clientWidth || W;
    var vh = window.innerHeight || document.documentElement.clientHeight || H;
    var scale = Math.min(vw / W, vh / H) || 1;
    fix(stage, "transform", "translate(" + (vw - W * scale) / 2 + "px, " + (vh - H * scale) / 2 + "px) scale(" + scale + ")");
  }
  function show(n, fromAddress) {
    if (!slides.length) return;
    n = Math.max(0, Math.min(slides.length - 1, Math.floor(Number(n) || 0)));
    index = n;
    slides.forEach(function (s, i) {
      if (i === n) return;
      fix(s, "display", "none");
      s.setAttribute("aria-hidden", "true");
    });
    var current = slides[n];
    current.removeAttribute("aria-hidden");
    current.style.removeProperty("display");
    var style = window.getComputedStyle(current);
    if (style.display === "none") fix(current, "display", "block");
    if (style.visibility === "hidden") fix(current, "visibility", "visible");
    // The bars around the slide take its colour, unless the deck coloured the page itself.
    if (ownBars) document.documentElement.style.background = style.backgroundColor === "rgba(0, 0, 0, 0)" ? "" : style.backgroundColor;
    if (style.opacity === "0") fix(current, "opacity", "1");
    if (counter) {
      counter.textContent = n + 1 + " / " + slides.length;
      counter.style.display = still || slides.length < 2 ? "none" : "";
    }
    if (!fromAddress) { try { history.replaceState(null, "", "#" + (n + 1)); } catch (e) {} }
    // mlch's viewer learns which slide is showing and how many there are (its slide bar, comments).
    try { if (parent !== window) parent.postMessage({ mlchDeckSlide: n + 1, mlchDeckCount: slides.length }, "*"); } catch (e) {}
  }
  function fromHash() {
    var m = /^#(\\d+)$/.exec(location.hash);
    return m ? Number(m[1]) - 1 : 0;
  }
  function overflow() {
    var slide = slides[index];
    if (!slide) return null;
    var box = slide.getBoundingClientRect();
    var scale = box.width / W || 1;
    var left = 0, top = 0, right = 0, bottom = 0;
    var all = slide.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!shows(el)) continue;
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      left = Math.min(left, (r.left - box.left) / scale);
      top = Math.min(top, (r.top - box.top) / scale);
      right = Math.max(right, (r.right - box.left) / scale);
      bottom = Math.max(bottom, (r.bottom - box.top) / scale);
    }
    right = Math.max(right, slide.scrollWidth);
    bottom = Math.max(bottom, slide.scrollHeight);
    if (left >= -2 && top >= -2 && right <= W + 2 && bottom <= H + 2) return null;
    return { slide: index + 1, left: Math.round(left), top: Math.round(top), right: Math.round(right), bottom: Math.round(bottom) };
  }
  /** Text, pictures and tables: what a person would miss if it were cut off. */
  function shows(el) {
    if (/^(img|svg|video|canvas|table|picture)$/i.test(el.tagName)) return true;
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && c.nodeValue.trim()) return true;
    return false;
  }
  // The viewer's slide bar moves the deck.
  window.addEventListener("message", function (e) {
    var go = e.data && e.data.mlchDeckGo;
    if (typeof go === "number") show(go - 1);
    // mlch's viewer shows its own counter under the deck.
    if (e.data && e.data.mlchDeckCounter === false && counter) counter.style.setProperty("visibility", "hidden", "important");
  });
  // A slide number typed, then Enter, goes there.
  var typed = "", typedAt = 0;
  document.addEventListener("keydown", function (e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    var k = e.key, next;
    if (/^[0-9]$/.test(k)) {
      typed = (Date.now() - typedAt < 1500 ? typed : "") + k;
      typedAt = Date.now();
      return;
    }
    if (k === "Enter" && typed && Date.now() - typedAt < 3000) {
      e.preventDefault();
      show(Number(typed) - 1);
      typed = "";
      return;
    }
    if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || k === "Enter" || (k === " " && !e.shiftKey)) next = index + 1;
    else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || (k === " " && e.shiftKey)) next = index - 1;
    else if (k === "Home") next = 0;
    else if (k === "End") next = slides.length - 1;
    else return;
    e.preventDefault();
    show(next);
  });
  var swipedAt = 0;
  document.addEventListener("click", function (e) {
    if (Date.now() - swipedAt < 500) return;
    var t = e.target;
    if (t && t.closest && t.closest("a, button, input, textarea, select, summary, label, video, audio, [contenteditable]")) return;
    if (window.getSelection && String(window.getSelection())) return;
    show(e.clientX < (window.innerWidth || W) / 2 ? index - 1 : index + 1);
  });
  // The wheel and trackpad: one slide per gesture, however long its momentum runs.
  var wheelTotal = 0, wheelDone = false, wheelQuiet;
  window.addEventListener("wheel", function (e) {
    if (e.ctrlKey) return;
    clearTimeout(wheelQuiet);
    wheelQuiet = setTimeout(function () { wheelTotal = 0; wheelDone = false; }, 220);
    if (wheelDone) return;
    wheelTotal += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(wheelTotal) < 40) return;
    wheelDone = true;
    show(index + (wheelTotal > 0 ? 1 : -1));
  }, { passive: true });
  var touch = null;
  document.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse") return;
    touch = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  document.addEventListener("pointerup", function (e) {
    if (!touch || e.pointerId !== touch.id) return;
    var dx = e.clientX - touch.x, dy = e.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    swipedAt = Date.now();
    show(index + (dx < 0 ? 1 : -1));
  });
  document.addEventListener("pointercancel", function () { touch = null; });
  window.addEventListener("hashchange", function () { show(fromHash(), true); });
  window.addEventListener("resize", fit);
  window.__mlchDeck = {
    get count() { return slides.length; },
    get expected() { return expected; },
    get index() { return index; },
    go: function (n) { show(n); },
    overflow: overflow
  };
  fit();
  show(fromHash(), true);
})();`;

export function buildDeck({ title, slides, css }: DeckInput): string {
  const sections = slides
    .slice(0, MAX_SLIDES)
    .map((html, i) => `<section class="slide" data-slide="${i + 1}">\n${html}\n</section>`)
    .join("\n");
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(title)}</title>
<style>
${PLAYER_CSS}
</style>
${css?.trim() ? `<style>\n${safeStyle(css)}\n</style>\n` : ""}</head>
<body>
<main id="mlch-deck" data-count="${Math.min(slides.length, MAX_SLIDES)}">
${sections}
</main>
<div id="mlch-counter" aria-hidden="true"></div>
<script>
${PLAYER_JS}
</script>
</body>
</html>
`;
  return withKindMeta(html, "deck");
}

export type Written = { content: string; kind?: ArtifactKind; slides?: number } | { problem: string };

/**
 * The file write_artifact saves: a deck built around its slides, a page with
 * its kind declared, anything else as written. A problem says what is allowed.
 */
export function writtenArtifact(title: string, extension: string, args: { content?: unknown; kind?: unknown; slides?: unknown; css?: unknown }): Written {
  const content = typeof args.content === "string" ? args.content : undefined;
  const slides = Array.isArray(args.slides) ? args.slides.filter((s): s is string => typeof s === "string") : undefined;
  const css = typeof args.css === "string" ? args.css : undefined;
  const kind = args.kind === "deck" || args.kind === "page" ? args.kind : undefined;
  if (extension !== "html") {
    if (kind || slides?.length) return { problem: "kind and slides are for HTML only (extension html). Other files are written whole in `content`." };
    return content === undefined ? { problem: "Give the file in `content`." } : { content };
  }
  if (kind === "deck" || (!kind && slides?.length)) {
    if (!slides?.length) {
      return { problem: `A deck is written as \`slides\`: one HTML string per slide, laid out in px for ${SLIDE_WIDTH}x${SLIDE_HEIGHT}, plus optional \`css\`. The player (scaling, navigation, counter) is added for you; leave out \`content\`.` };
    }
    if (slides.length > MAX_SLIDES) return { problem: `A deck has at most ${MAX_SLIDES} slides.` };
    return { content: buildDeck({ title, slides, css }), kind: "deck", slides: slides.length };
  }
  if (slides?.length) return { problem: "`slides` make a deck: use kind \"deck\" with slides, or kind \"page\" with the whole page in `content`." };
  if (content === undefined) return { problem: "A page is written whole in `content` (a complete HTML document). For slides, use kind \"deck\" with `slides`." };
  return { content: withKindMeta(content, "page"), kind: "page" };
}

/**
 * The player, added to a deck the maker wrote in mlch's format (one `<section class="slide">` per
 * slide, `<meta name="mlch:kind" content="deck">`, no script of its own), so it moves like the
 * others (keys, click, swipe, the viewer's slide bar). Anything else is left as it is.
 */
export function withPlayer(html: string): string {
  if (html.includes("__mlchDeck") || /<script\b/i.test(html)) return html;
  if (!/<meta[^>]+name=["']mlch:kind["'][^>]+content=["']deck["']/i.test(html)) return html;
  let n = 0;
  const marked = html.replace(/<section\b([^>]*\bclass=["'][^"']*\bslide\b[^"']*["'][^>]*)>/gi, (_all, attrs: string) => `<section${attrs.replace(/\sdata-slide=["'][^"']*["']/i, "")} data-slide="${++n}">`);
  if (n < 2 || n > MAX_SLIDES) return html;
  const withStyle = marked.replace(/<head([^>]*)>/i, (all) => `${all}\n<style>\n${PLAYER_CSS}\n</style>`);
  const player = `<div id="mlch-counter" aria-hidden="true"></div>\n<script>\n${PLAYER_JS}\n</script>\n`;
  return /<\/body>/i.test(withStyle) ? withStyle.replace(/<\/body>/i, `${player}</body>`) : `${withStyle}\n${player}`;
}

/** A deck mlch built with an older player gets today's (the viewer's slide bar, a typed slide number). */
export function currentPlayer(html: string): string {
  if (!html.includes("window.__mlchDeck") || html.includes("mlchDeckSlide")) return html;
  const start = html.indexOf("<script>\n(function () {\n  var W = ");
  if (start < 0) return html;
  const end = html.indexOf("</script>", start);
  if (end < 0) return html;
  return `${html.slice(0, start)}<script>\n${PLAYER_JS}\n${html.slice(end)}`;
}
