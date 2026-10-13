/**
 * What kind of made HTML file something is: a deck (slides, shown one at a
 * time by the player in deck.ts) or a page (one column that scrolls). Pure, so
 * the app, the shared viewer and the share Worker all use it.
 */

export type ArtifactKind = "deck" | "page";

const KIND_META = /<meta\s+name=["']mlch:kind["']\s+content=["'](deck|page)["'][^>]*>/i;

/**
 * The kind a file declares in `<meta name="mlch:kind">`. Files without one
 * (made before kinds, or by the maker lane) are pages, unless they look like a
 * hand-made deck: slide sections and a keyboard handler.
 */
export function artifactKindOf(html: string): ArtifactKind {
  const declared = KIND_META.exec(html)?.[1]?.toLowerCase();
  if (declared === "deck" || declared === "page") return declared;
  const slides = /class\s*=\s*["'][^"']*\bslide\b/i.test(html);
  const keys = /keydown|onkeydown|keyup/i.test(html);
  return slides && keys ? "deck" : "page";
}

/** The file with its kind declared (an existing declaration replaced). */
export function withKindMeta(html: string, kind: ArtifactKind): string {
  const tag = `<meta name="mlch:kind" content="${kind}">`;
  if (KIND_META.test(html)) return html.replace(KIND_META, tag);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}\n${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (open) => `${open}\n<head>${tag}</head>`);
  // After a doctype, never before it (that would put the page in quirks mode).
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `${doctype[0]}\n${tag}${html.slice(doctype[0].length)}` : `${tag}\n${html}`;
}
