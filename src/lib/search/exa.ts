/**
 * Exa web search (optional key). Server-only.
 *
 * In the search bake-off (docs/research/search-bakeoff.md) Exa beat the
 * built-in web search for company/competitor scans, research papers and
 * recent news; built-in search stays the default for general questions.
 */

import { getCredential } from "@/lib/desktop/server";

export interface ExaResult {
  title: string;
  url: string;
  publishedDate?: string;
  text?: string;
}

export function exaAvailable(): boolean {
  return !!getCredential("exa");
}

export async function exaSearch(options: { query: string; category?: string; startPublishedDate?: string; numResults?: number }): Promise<ExaResult[]> {
  const key = getCredential("exa");
  if (!key) throw new Error("No Exa key.");
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: options.query,
      type: "auto",
      numResults: Math.min(20, options.numResults ?? 10),
      ...(options.category ? { category: options.category } : {}),
      ...(options.startPublishedDate ? { startPublishedDate: options.startPublishedDate } : {}),
      contents: { text: { maxCharacters: 1500 } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Exa search failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  const data = (await response.json()) as { results?: Array<{ title?: string; url: string; publishedDate?: string; text?: string }> };
  return (data.results ?? []).map((r) => ({ title: r.title ?? r.url, url: r.url, ...(r.publishedDate ? { publishedDate: r.publishedDate.slice(0, 10) } : {}), ...(r.text ? { text: r.text } : {}) }));
}
