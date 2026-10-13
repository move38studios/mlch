/**
 * The page a shared made file (an HTML deck or page, an SVG) opens in: the file
 * in a sandboxed frame filling the window, as in the app. A deck letterboxes its
 * own slides (src/lib/artifacts/deck.ts) and gets Full screen where the browser
 * can do it (not on an iPhone); a page scrolls, edge to edge. The file itself
 * stays at /s/<id>/<entry>.
 */

import type { ArtifactKind } from "../../src/lib/artifacts/kind";

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Wording is placeholder (George). */
export function framePage(title: string, entry: string, nonce: string, kind: ArtifactKind = "page"): string {
  const name = escape(title || entry);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${name}</title>
<link rel="icon" href="/brand/icon.svg" type="image/svg+xml">
<link rel="icon" href="/brand/icon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/brand/icon-180.png">
<style>
  html, body { margin: 0; height: 100%; background: #161616; font: 13px/1 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
  #stage { position: fixed; inset: 0; display: flex; box-sizing: border-box; }
  iframe { flex: 1; min-width: 0; height: 100%; border: 0; background: #fff; }
  /* A deck: the frame above, Full screen in its own strip below, so the slides never cover it. */
  body.deck #stage { padding: 12px 12px 0; }
  body.deck.full #stage { bottom: 48px; }
  body.deck iframe { background: #000; border-radius: 10px; }
  body.deck #stage:fullscreen { inset: 0; padding: 0; background: #000; }
  body.deck #stage:fullscreen iframe { border-radius: 0; }
  @media (max-width: 640px) { body.deck #stage { padding: 0; } body.deck iframe { border-radius: 0; } }
  #bar { display: none; position: fixed; left: 0; right: 0; bottom: 0; height: 48px; padding: 0 12px; box-sizing: border-box; align-items: center; justify-content: flex-end; gap: 6px; }
  body.deck.full #bar { display: flex; }
  button { height: 30px; padding: 0 12px; border: 0; border-radius: 8px; background: rgba(255,255,255,.14); color: #fff; font: inherit; cursor: pointer; }
  button:hover { background: rgba(255,255,255,.24); }
  :fullscreen ~ #bar { display: none !important; }
</style>
</head>
<body class="${kind}">
<div id="stage"><iframe src="${escape(encodeURI(entry))}" sandbox="allow-scripts" title="${name}"></iframe></div>
<div id="bar">
  <button id="full" type="button">Full screen</button>
</div>
<script nonce="${nonce}">
  const stage = document.getElementById("stage");
  const frame = stage.querySelector("iframe");
  frame.addEventListener("load", () => frame.focus());
  // Only where full screen does something: an iPhone has neither.
  if (document.fullscreenEnabled || document.webkitFullscreenEnabled) document.body.classList.add("full");
  document.getElementById("full").addEventListener("click", () => {
    const go = stage.requestFullscreen ? stage.requestFullscreen() : stage.webkitRequestFullscreen && stage.webkitRequestFullscreen();
    if (go && go.catch) go.catch(() => {});
  });
  document.addEventListener("fullscreenchange", () => frame.focus());
</script>
</body>
</html>
`;
}

export function frameCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
