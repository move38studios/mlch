"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink, FolderOpen, X } from "lucide-react";
import { desktop } from "@/lib/desktop/client";
import { useNapkin } from "@/lib/napkin/client";
import { KIND_STYLES } from "./kinds";
import { MediaPlayer } from "./MediaBody";
import { useCanvasUi } from "./ui";

/** The full content of one node: long write-ups, documents, search results. */
export function SidePanel() {
  const openId = useCanvasUi((s) => s.openId);
  const setOpen = useCanvasUi((s) => s.setOpen);
  const napkinId = useNapkin((s) => s.id);
  const node = useNapkin((s) => (openId ? s.napkin?.nodes[openId] : undefined));
  const [full, setFull] = useState<{ assetId: string; text: string }>();
  const textAsset = node?.assetId && (node.kind === "doc" || node.kind === "link") ? `${node.assetId.split(".")[0]}.md` : undefined;

  // Documents and links show their whole extracted text, which lives beside the file.
  useEffect(() => {
    if (!textAsset || !napkinId) return;
    let cancelled = false;
    fetch(`/api/napkins/${napkinId}/assets/${textAsset}`)
      .then((response) => (response.ok ? response.text() : undefined))
      .then((text) => {
        if (!cancelled && text) setFull({ assetId: textAsset, text });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [napkinId, textAsset]);

  if (!node) return null;
  const body = full && full.assetId === textAsset ? full.text : node.text;
  const revealable = desktop() && ((node.assetId && node.kind !== "link") || node.docPath);
  const reveal = () =>
    fetch(`/api/napkins/${napkinId}/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(node.docPath ? { docPath: node.docPath } : { assetId: node.assetId }),
    });
  const label = KIND_STYLES[node.kind].label;
  return (
    <aside className="w-[min(560px,45%)] shrink-0 border-l border-line bg-white flex flex-col">
      <div className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-line text-xs text-ink-3">
        {label && <span className="uppercase tracking-wider font-medium">{label}</span>}
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
      <div className="flex-1 overflow-auto px-6 py-5">
        {node.kind === "media" && napkinId && (
          <div className="-mx-6 -mt-5 mb-4 bg-paper-2">
            <MediaPlayer node={node} napkinId={napkinId} large />
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
        <div className="napkin-md napkin-md-full text-[14px] leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
        </div>
      </div>
    </aside>
  );
}
