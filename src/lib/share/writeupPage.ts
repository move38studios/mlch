/**
 * A write-up (a call's transcript or notes, any write-up) as a page of its own, for sharing it
 * without the canvas: its markdown rendered (raw HTML in it stays text), on paper, readable on a phone.
 * Server-only.
 */

import type { Element, Nodes, Root } from "hast";
import { toHast } from "mdast-util-to-hast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { withKindMeta } from "@/lib/artifacts/kind";

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const VOID = new Set(["br", "hr", "img", "input"]);
/** Only plain attributes, and links only to the web or mail. */
function attributes(element: Element): string {
  return Object.entries(element.properties ?? {})
    .flatMap(([name, value]) => {
      if (value === undefined || value === null || value === false) return [];
      const key = name === "className" ? "class" : name.toLowerCase();
      if (key.startsWith("on") || key === "style") return [];
      const text = Array.isArray(value) ? value.join(" ") : String(value);
      if ((key === "href" || key === "src") && !/^(https?:|mailto:|#)/i.test(text)) return [];
      return [value === true ? ` ${key}` : ` ${key}="${escape(text)}"`];
    })
    .join("");
}

/** HTML from the markdown's tree: text escaped, raw HTML never passed through. */
function serialize(node: Nodes): string {
  if (node.type === "root") return node.children.map(serialize).join("");
  if (node.type === "text") return escape(node.value);
  if (node.type === "element") {
    const open = `<${node.tagName}${attributes(node)}>`;
    return VOID.has(node.tagName) ? open : `${open}${node.children.map(serialize).join("")}</${node.tagName}>`;
  }
  return "";
}

function markdownToHtml(markdown: string): string {
  const processor = unified().use(remarkParse).use(remarkGfm);
  const tree = processor.runSync(processor.parse(markdown));
  return serialize(toHast(tree as Parameters<typeof toHast>[0]) as Root);
}

const STYLE = `html { background: #FCFCFA; color: #000; -webkit-text-size-adjust: 100%; }
body { margin: 0; font: 17px/1.6 "Schibsted Grotesk", -apple-system, system-ui, sans-serif; }
main { max-width: 70ch; margin: 0 auto; padding: 48px 24px 64px; }
h1 { font-size: 30px; line-height: 1.2; letter-spacing: -0.01em; margin: 0 0 24px; }
h2 { font-size: 21px; margin: 32px 0 8px; } h3 { font-size: 18px; margin: 24px 0 6px; }
p, ul, ol { margin: 0 0 14px; } li { margin: 4px 0; }
a { color: inherit; } img, table { max-width: 100%; }
table { border-collapse: collapse; } td, th { border: 1px solid rgba(0,0,0,0.1); padding: 6px 10px; text-align: left; }
blockquote { margin: 0 0 14px; padding-left: 14px; border-left: 2px solid rgba(0,0,0,0.15); color: rgba(0,0,0,0.64); }
code { font-size: 0.92em; } footer { margin-top: 48px; font-size: 13px; color: rgba(0,0,0,0.4); }`;

export function writeupPage(title: string, markdown: string): string {
  // The card's title leads; a first heading that repeats it is left out.
  const body = markdown.replace(/^#\s+(.+)\n+/, (all, heading: string) => (heading.trim() === title.trim() ? "" : all));
  const html = markdownToHtml(body);
  return withKindMeta(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escape(title)}</h1>
${html}
<footer>made with mlch</footer>
</main>
</body>
</html>
`,
    "page",
  );
}
