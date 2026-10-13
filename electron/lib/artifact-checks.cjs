// mlch: what the hidden preview window measures in a made file (see main.cjs
// renderArtifact). Each script runs in the page and returns plain data; the app
// phrases it as problems (src/lib/artifacts/checks.ts).

/** How many slides are showing: not hidden, with a size. Slides inside slides are not counted twice. */
const VISIBLE_SLIDES = `(() => Array.from(document.querySelectorAll('[data-slide], .slide')).filter((el) => {
  if (el.parentElement && el.parentElement.closest('[data-slide], .slide')) return false;
  const s = getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}).length)()`;

/** A page at the window's current size: its full width and height, whether it can scroll, and text under 12px. */
const PAGE_MEASURE = `(() => {
  const d = document.documentElement, b = document.body;
  const hides = (el) => !!el && /hidden|clip/.test(getComputedStyle(el).overflowY);
  const small = [];
  const walker = document.createTreeWalker(b || d, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && small.length < 8; n = walker.nextNode()) {
    const text = n.nodeValue.trim();
    const el = n.parentElement;
    if (!text || !el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const size = parseFloat(s.fontSize);
    if (size < 12) small.push({ text: text.replace(/\\s+/g, ' ').slice(0, 40), size: Math.round(size * 10) / 10 });
  }
  return {
    width: innerWidth,
    height: innerHeight,
    scrollWidth: Math.max(d.scrollWidth, b ? b.scrollWidth : 0),
    scrollHeight: Math.max(d.scrollHeight, b ? b.scrollHeight : 0),
    clipped: hides(d) || hides(b),
    smallText: small,
  };
})()`;

/** The render request's options: how many screens to step through, and the file's kind if it has one. */
function renderOptions(options) {
  const value = typeof options === 'number' ? { steps: options } : options && typeof options === 'object' ? options : {};
  const steps = Number.isFinite(value.steps) ? Math.max(1, Math.min(8, Math.floor(value.steps))) : 1;
  const kind = value.kind === 'deck' || value.kind === 'page' ? value.kind : undefined;
  return { steps, kind };
}

module.exports = { VISIBLE_SLIDES, PAGE_MEASURE, renderOptions };
