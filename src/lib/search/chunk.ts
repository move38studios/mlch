/** Splitting text into passages for the search index. Pure. */

export interface Passage {
  text: string;
  /** 1-based page for PDFs (from the extractor's page markers). */
  page?: number;
  /** Character offset in the source text. */
  offset: number;
}

const TARGET = 900;
const OVERLAP = 120;

/**
 * Passages of about TARGET characters, cut at paragraph or sentence ends,
 * overlapping a little so a quote across a cut is still found whole.
 * Page markers ("--- page N ---") set the page of what follows.
 */
export function chunkText(source: string): Passage[] {
  const passages: Passage[] = [];
  const pagePattern = /--- page (\d+) ---/g;
  const pages: Array<{ at: number; page: number }> = [];
  for (const match of source.matchAll(pagePattern)) pages.push({ at: match.index ?? 0, page: Number(match[1]) });
  const pageAt = (offset: number) => {
    let page: number | undefined;
    for (const p of pages) if (p.at <= offset) page = p.page;
    return page;
  };
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + TARGET);
    if (end < source.length) {
      const window = source.slice(start + TARGET / 2, end);
      const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
      if (cut > 0) end = start + TARGET / 2 + cut + 1;
    }
    const raw = source.slice(start, end);
    const text = raw.replace(pagePattern, " ").replace(/\s+/g, " ").trim();
    if (text.length > 20) passages.push({ text, offset: start, ...(pageAt(start + raw.search(/\S/)) !== undefined ? { page: pageAt(start + Math.max(0, raw.search(/\S/))) } : {}) });
    if (end >= source.length) break;
    start = Math.max(start + 1, end - OVERLAP);
  }
  return passages;
}

/** Plain text from HTML (artifacts). */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
