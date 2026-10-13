"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink, FolderOpen, Link2, Pencil, X } from "lucide-react";
import { desktop } from "@/lib/desktop/client";
import { useMulch } from "@/lib/mulch/client";
import { KIND_STYLES } from "./kinds";
import { MediaPlayer } from "./MediaBody";
import { useCanvasUi } from "./ui";
import { useResolvedRef } from "./refs";
import { useBacklinks } from "./backlinks";
import type { Mulch, MulchNode } from "@/lib/mulch/types";

const BUTTON = "px-2.5 py-1 rounded-lg text-[13px]";

/** Items connected to the target in its own mulch, for context. */
function useNeighbours(mulchId?: string, itemId?: string): MulchNode[] {
  const [mulch, setMulch] = useState<Mulch>();
  useEffect(() => {
    if (!mulchId) return;
    let cancelled = false;
    fetch(`/api/mulches/${mulchId}`)
      .then((response) => (response.ok ? (response.json() as Promise<{ mulch: Mulch }>) : undefined))
      .then((body) => !cancelled && setMulch(body?.mulch))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mulchId]);
  if (!mulch || !itemId) return [];
  const ids = Object.values(mulch.edges).flatMap((edge) => (edge.source === itemId ? [edge.target] : edge.target === itemId ? [edge.source] : []));
  return [...new Set(ids)].map((id) => mulch.nodes[id]).filter((node): node is MulchNode => !!node && node.kind !== "ref").slice(0, 8);
}

/** A link card opened: the target in full, where it lives, and what it connects to there. */
function RefPanel({ node, mulchId, onClose }: { node: MulchNode; mulchId: string; onClose: () => void }) {
  const router = useRouter();
  const readOnly = useCanvasUi((s) => s.readOnly);
  const ref = node.ref!;
  const target = useResolvedRef(ref, true);
  const inMulch = "mulchId" in ref ? ref : undefined;
  const neighbours = useNeighbours(inMulch?.mulchId, inMulch?.itemId);
  const open = () => {
    if ("mulchId" in ref) router.push(`/n/${ref.mulchId}?focus=${ref.itemId}`);
    else void fetch("/api/sources/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId: ref.sourceId, path: ref.path }) });
  };
  const bring = async () => {
    const response = await fetch(`/api/mulches/${mulchId}/bring`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeId: node.id }) });
    if (response.ok) onClose();
  };
  return (
    <aside className="float w-[min(560px,45%)] shrink-0 my-3 mr-3 rounded-2xl flex flex-col overflow-hidden">
      <div className="h-12 shrink-0 flex items-center gap-2 pl-6 pr-3 text-[12.5px] text-ink-3 min-w-0">
        <Link2 size={13} strokeWidth={1.75} className="shrink-0" />
        <span className="truncate">{target?.place}</span>
        {"sourceId" in ref && <span className="truncate">{ref.path}</span>}
        <div className="flex-1" />
        {target?.exists && (
          <button onClick={open} className={`${BUTTON} bg-ink text-white`}>
            Open
          </button>
        )}
        {target?.exists && !readOnly && (
          <button onClick={() => void bring()} className={`${BUTTON} text-ink-2 hover:bg-paper-2 hover:text-ink`}>
            Bring here
          </button>
        )}
        <button onClick={onClose} title="Close" aria-label="Close" className="p-1.5 rounded-lg hover:bg-paper-2 text-ink-2 hover:text-ink">
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex-1 overflow-auto px-6 pt-1 pb-8">
        {(target?.title ?? node.title) && <h2 className="text-[22px] font-semibold leading-[1.2] tracking-[-0.015em] mb-4">{target?.title ?? node.title}</h2>}
        {target && !target.exists ? (
          <p className="text-[15px] text-ink-3">Removed</p>
        ) : (
          <div className="mlch-md mlch-md-full text-[15px] leading-[1.6]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{target?.text ?? ""}</ReactMarkdown>
          </div>
        )}
        {neighbours.length > 0 && (
          <div className="mt-6 pt-4 border-t border-line">
            <div className="text-[12.5px] text-ink-3 mb-2">Connected there</div>
            <ul className="space-y-1.5">
              {neighbours.map((n) => (
                <li key={n.id}>
                  <Link href={`/n/${inMulch!.mulchId}?focus=${n.id}`} className="block text-[14px] text-ink-2 hover:text-ink line-clamp-2">
                    {n.title || n.text}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}

/** Link cards elsewhere that point at this item. */
function LinkedFrom({ mulchId, itemId }: { mulchId: string; itemId: string }) {
  const links = useBacklinks(mulchId).filter((link) => link.itemId === itemId);
  if (!links.length) return null;
  return (
    <div className="mt-6 pt-4 border-t border-line">
      <div className="text-[12.5px] text-ink-3 mb-2">Linked from</div>
      <ul className="space-y-1.5">
        {links.map((link) => (
          <li key={`${link.mulchId}/${link.nodeId}`}>
            <Link href={`/n/${link.mulchId}?focus=${link.nodeId}`} className="text-[14px] text-ink-2 hover:text-ink">
              {link.mulchTitle}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  const readOnly = useCanvasUi((s) => s.readOnly);
  const apply = useMulch((s) => s.apply);
  const contentRef = useRef<HTMLDivElement>(null);
  // Editing the item's own text (as double-click does on the card); documents show text extracted from a file, so not those.
  const [draft, setDraft] = useState<string>();
  useEffect(() => setDraft(undefined), [openId]);

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
  if (node.kind === "ref" && node.ref && mulchId) return <RefPanel key={node.id} node={node} mulchId={mulchId} onClose={() => setOpen(undefined)} />;
  const body = full && full.assetId === textAsset ? full.text : node.text;
  const revealable = desktop() && ((node.assetId && node.kind !== "link") || node.docPath);
  const reveal = () =>
    fetch(`/api/mulches/${mulchId}/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(node.docPath ? { docPath: node.docPath } : { assetId: node.assetId }),
    });
  const label = KIND_STYLES[node.kind].label;
  const editable = !readOnly && !textAsset && !["artifact", "image", "media", "ref"].includes(node.kind);
  const save = () => {
    if (draft !== undefined && draft !== node.text && draft.trim()) apply([{ op: "updateNode", id: node.id, patch: { text: draft, userTouched: true, updatedAt: Date.now() } }]);
    setDraft(undefined);
  };
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
        {editable && draft === undefined && (
          <button onClick={() => setDraft(node.text)} className="p-1.5 rounded-lg hover:bg-paper-2 text-ink-2 hover:text-ink" title="Edit" aria-label="Edit">
            <Pencil size={14} strokeWidth={1.75} />
          </button>
        )}
        {draft !== undefined && (
          <button onClick={save} className="h-7 px-2.5 rounded-lg bg-ink text-white text-[12.5px] font-medium">
            Done
          </button>
        )}
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
        {draft !== undefined ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
                e.preventDefault();
                save();
              }
            }}
            aria-label="Text"
            className="w-full min-h-[50vh] resize-none bg-transparent outline-none text-[14.5px] leading-[1.6] font-mono field-sizing-content"
          />
        ) : (
          <div className="mlch-md mlch-md-full text-[15px] leading-[1.6]" onDoubleClick={editable ? () => setDraft(node.text) : undefined}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          </div>
        )}
        {mulchId && <LinkedFrom mulchId={mulchId} itemId={node.id} />}
      </div>
    </aside>
  );
}
