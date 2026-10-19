/**
 * Links in a made file open in a new tab: a frame can't show other sites
 * (the app blocks it, and most sites refuse to be framed), so a web link
 * clicked inside a deck or a page is handed to the page around it, which
 * opens it only right after a real click (ArtifactViewer, the share's frame
 * page; in the app, main sends new windows to the browser). The file itself
 * still can't open windows (its sandbox has no popups). Opened on its own, it
 * opens the link itself. Links within the file (#part, its own files) stay in
 * place. Added when the file is served, in the app and on a share server, so
 * files made before work too. Pure: used by the cloud too.
 */

const MARK = "data-mlch-links";

/** On a click on a web link to another site: a new tab, through the page around it when there is one. */
export const LINKS_SCRIPT = `<script ${MARK}>
document.addEventListener("click", function (e) {
  if (e.defaultPrevented || e.button !== 0) return;
  var a = e.target && e.target.closest && e.target.closest("a[href]");
  if (!a) return;
  var url;
  try { url = new URL(a.getAttribute("href"), location.href); } catch (_) { return; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.host === location.host) return;
  e.preventDefault();
  if (window.parent !== window) window.parent.postMessage({ mlchOpenLink: url.href }, "*");
  else window.open(url.href, "_blank", "noopener,noreferrer");
}, true);
</script>`;

/** The file with LINKS_SCRIPT, at the start of its head (or the start of the file). */
export function withLinks(html: string): string {
  if (html.includes(MARK)) return html;
  const head = /<head[^>]*>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + LINKS_SCRIPT + html.slice(head.index + head[0].length) : LINKS_SCRIPT + html;
}
