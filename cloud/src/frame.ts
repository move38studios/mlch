/**
 * The page a shared made file (an HTML page or deck, an SVG) opens in: the file
 * in a sandboxed frame on a 16:9 stage, as in the app, with Full screen and a
 * switch to fill the window. The file itself stays at /s/<id>/<entry>.
 */

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Wording is placeholder (George). */
export function framePage(title: string, entry: string, nonce: string): string {
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
  /* The page above, the buttons in their own strip below, so a large page never covers them. */
  #stage { position: fixed; inset: 0 0 48px 0; display: grid; place-items: center; container-type: size; padding: 12px 12px 0; box-sizing: border-box; }
  #stage:fullscreen { inset: 0; padding: 0; background: #000; }
  iframe { border: 0; background: #fff; border-radius: 10px; width: min(100cqw, 100cqh * 16 / 9); aspect-ratio: 16 / 9; }
  #stage:fullscreen iframe { border-radius: 0; }
  body.fill iframe { width: 100%; height: 100%; aspect-ratio: auto; }
  #bar { position: fixed; left: 0; right: 0; bottom: 0; height: 48px; padding: 0 12px; box-sizing: border-box; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
  button { height: 30px; padding: 0 12px; border: 0; border-radius: 8px; background: rgba(255,255,255,.14); color: #fff; font: inherit; cursor: pointer; }
  button:hover { background: rgba(255,255,255,.24); }
  :fullscreen ~ #bar { display: none; }
</style>
</head>
<body>
<div id="stage"><iframe src="${escape(encodeURI(entry))}" sandbox="allow-scripts" title="${name}"></iframe></div>
<div id="bar">
  <button id="fill" type="button">Fill the window</button>
  <button id="full" type="button">Full screen</button>
</div>
<script nonce="${nonce}">
  const stage = document.getElementById("stage");
  const frame = stage.querySelector("iframe");
  const fill = document.getElementById("fill");
  frame.addEventListener("load", () => frame.focus());
  document.getElementById("full").addEventListener("click", () => (stage.requestFullscreen ? stage.requestFullscreen() : frame.webkitRequestFullscreen && frame.webkitRequestFullscreen()).catch?.(() => {}));
  fill.addEventListener("click", () => { fill.textContent = document.body.classList.toggle("fill") ? "16:9" : "Fill the window"; frame.focus(); });
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
