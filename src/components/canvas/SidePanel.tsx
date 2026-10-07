"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink, FolderOpen, X } from "lucide-react";
import { desktop } from "@/lib/desktop/client";
import { useMulch } from "@/lib/mulch/client";
import { KIND_STYLES } from "./kinds";
import { MediaPlayer } from "./MediaBody";
import { useCanvasUi } from "./ui";

// The colour of a found passage. Kept out of the stylesheet: the CSS optimiser
// does not know ::highlight() (the CSS Custom Highlight API) and warns about it.
const HIGHLIGHT_STYLE = "::highlight(mlch-find) { background-color: rgba(255, 192, 0, 0.5); }";

/** The full content of one node (write-ups, documents, sources), in a panel beside the canvas. */
export function SidePanel() {
  const openId = useCanvasUi((s) => s.openId);
  const setOpen = useCanvasUi((s) => s.setOpen);
  const mulchId = useMulch((s) => s.id);
  const node = useMulch((s) => (openId ? s.mulch?.nodes[openId] : undefined));
  const [full, setFull] = useState<{ assetId: string; text: string }>();
  const textAsset = node?.assetId && (node.kind === "doc" || node.kind === "link") ? `${node.assetId.split(".")[0]}.md` : undefined;

  // Documents and links show their whole extracted text, which lives beside the file.
  useEffect(() => {
    if (!textAsset || !mulchId) return;
    let cancelled = false;
    fetch(`/api/mulches/${mulchId}/assets/${textAsset}`)
      .then((response) => (response.ok ? response.text() : undefined))
      .then((text) => {
        if (!cancelled && text) setFull({ assetId: textAsset, text });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mulchId, textAsset]);

  const highlight = useCanvasUi((s) => s.highlight);
  const contentRef = useRef<HTMLDivElement>(null);

  // Find the quote (or page marker) in the shown text, highlight and scroll to it.
  useEffect(() => {
    const root = contentRef.current;
    const needle = (highlight?.quote ?? (highlight?.page ? `--- page ${highlight.page} ---` : "")).trim().toLowerCase().slice(0, 80);
    if (!root || !needle || typeof CSS === "undefined" || !("highlights" in CSS)) return;
    const timer = setTimeout(() => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const at = (text.textContent ?? "").toLowerCase().indexOf(needle.slice(0, Math.min(needle.length, 60)));
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(text, at);
        range.setEnd(text, Math.min((text.textContent ?? "").length, at + needle.length));
        (CSS as unknown as { highlights: Map<string, unknown> }).highlights.set("mlch-find", new (window as unknown as { Highlight: new (r: Range) => unknown }).Highlight(range));
        (text.parentElement ?? root).scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [highlight, full, node?.id]);

  if (!node) return null;
  const body = full && full.assetId === textAsset ? full.text : node.text;
  const revealable = desktop() && ((node.assetId && node.kind !== "link") || node.docPath);
  const reveal = () =>
    fetch(`/api/mulches/${mulchId}/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(node.docPath ? { docPath: node.docPath } : { assetId: node.assetId }),
    });
  const label = KIND_STYLES[node.kind].label;
  return (
    <aside className="float w-[min(560px,45%)] shrink-0 my-3 mr-3 rounded-2xl flex flex-col overflow-hidden">
      <div className="h-12 shrink-0 flex items-center gap-2 pl-6 pr-3 text-[12.5px] text-ink-3">
        {label && <span>{label}</span>}
        {node.fileName && <span className="truncate">{node.fileName}</span>}
        {node.url && (
          <a href={node.url} target="_blank" rel="noreferrer" className="truncate hover:text-ink inline-flex items-center gap-1">
            {node.url} <ExternalLink size={11} />
          </a>
        )}
        <div className="flex-1" />
        {revealable && (
          <button onClick={reveal} className="p-1.5 rounded-lg hover:bg-paper-2 text-ink-2 hover:text-ink" title="Show in Finder" aria-label="Show in Finder">
            <FolderOpen size={15} strokeWidth={1.75} />
          </button>
        )}
        <button onClick={() => setOpen(undefined)} title="Close" aria-label="Close" className="p-1.5 rounded-lg hover:bg-paper-2 text-ink-2 hover:text-ink">
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <style>{HIGHLIGHT_STYLE}</style>
      <div ref={contentRef} className="flex-1 overflow-auto px-6 pt-1 pb-8">
        {node.kind === "media" && mulchId && (
          <div className="-mx-6 mb-4 bg-paper-2">
            <MediaPlayer node={node} mulchId={mulchId} large />
          </div>
        )}
        {node.title && <h2 className="text-[22px] font-semibold leading-[1.2] tracking-[-0.015em] mb-4">{node.title}</h2>}
        {node.gen && (
          <p className="text-[12.5px] text-ink-3 mb-3">
            {node.gen.endpoint}
            {node.gen.cost !== undefined && `, about $${node.gen.cost.toFixed(3)}`}
            {node.gen.error && `, ${node.gen.error}`}
          </p>
        )}
        <div className="mlch-md mlch-md-full text-[15px] leading-[1.6]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
        </div>
      </div>
    </aside>
  );
}
