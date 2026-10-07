"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink, X } from "lucide-react";
import { useNapkin } from "@/lib/napkin/client";
import { KIND_STYLES } from "./kinds";
import { useCanvasUi } from "./ui";

/** The full content of one node: long write-ups, documents, search results. */
export function SidePanel() {
  const openId = useCanvasUi((s) => s.openId);
  const setOpen = useCanvasUi((s) => s.setOpen);
  const node = useNapkin((s) => (openId ? s.napkin?.nodes[openId] : undefined));
  if (!node) return null;
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
        <button onClick={() => setOpen(undefined)} aria-label="Close" className="p-1 rounded hover:bg-paper-2 text-ink-2">
          <X size={15} />
        </button>
      </div>
      <div className="flex-1 overflow-auto px-6 py-5">
        {node.title && <h2 className="text-lg font-semibold mb-3">{node.title}</h2>}
        <div className="napkin-md napkin-md-full text-[14px] leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.text}</ReactMarkdown>
        </div>
      </div>
    </aside>
  );
}
