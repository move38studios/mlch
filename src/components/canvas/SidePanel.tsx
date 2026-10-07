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

/** The full content of one node: long write-ups, documents, search results. */
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
    <aside className="w-[min(560px,45%)] shrink-0 border-l border-line bg-white flex flex-col">
      <div className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-line text-xs text-ink-3">
        {label && <span>{label}</span>}
        {node.fileName && <span className="truncate">{node.fileName}</span>}
        {node.url && (
          <a href={node.url} target="_blank" rel="noreferrer" className="truncate hover:text-ink inline-flex items-center gap-1">
            {node.url} <ExternalLink size={11} />
          </a>
        )}
        <div className="flex-1" />
        {revealable && (
          <button onClick={reveal} className="p-1 rounded hover:bg-paper-2 text-ink-2" title="Show in Finder" aria-label="Show in Finder">
            <FolderOpen size={15} />
          </button>
        )}
        <button onClick={() => setOpen(undefined)} aria-label="Close" className="p-1 rounded hover:bg-paper-2 text-ink-2">
          <X size={15} />
        </button>
      </div>
      <div ref={contentRef} className="flex-1 overflow-auto px-6 py-5">
        {node.kind === "media" && mulchId && (
          <div className="-mx-6 -mt-5 mb-4 bg-paper-2">
            <MediaPlayer node={node} mulchId={mulchId} large />
          </div>
        )}
        {node.title && <h2 className="text-lg font-semibold mb-3">{node.title}</h2>}
        {node.gen && (
          <p className="text-xs text-ink-3 mb-3">
            {node.gen.endpoint}
            {node.gen.cost !== undefined && ` · about $${node.gen.cost.toFixed(3)}`}
            {node.gen.error && ` · ${node.gen.error}`}
          </p>
        )}
        <div className="mlch-md mlch-md-full text-[14px] leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
        </div>
      </div>
    </aside>
  );
}
