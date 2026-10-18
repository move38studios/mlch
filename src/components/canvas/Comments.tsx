"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import { create } from "zustand";
import { newClientId } from "@/lib/mulch/ids";
import { useMulch } from "@/lib/mulch/client";
import type { Mulch, MulchComment } from "@/lib/mulch/types";

/**
 * Comments on items: the person's notes to the AI on a card, a slide or a
 * made file. They never act by themselves: they go with the next instruction
 * (lib/agent/turn.ts), and the AI closes each with what it did.
 */

export const useComments = create<{
  /** The item whose comments are open, where on screen, and where in it (a slide). */
  open?: { nodeId: string; x: number; y: number; at?: MulchComment["at"] };
  show(open?: { nodeId: string; x: number; y: number; at?: MulchComment["at"] }): void;
}>((set) => ({ show: (open) => set({ open }) }));

export function commentsOn(mulch: Mulch | undefined, nodeId: string): MulchComment[] {
  return Object.values(mulch?.comments ?? {})
    .filter((comment) => comment.nodeId === nodeId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Comments not yet handed to the AI. */
export function unsentComments(mulch: Mulch | undefined): MulchComment[] {
  return Object.values(mulch?.comments ?? {}).filter((comment) => !comment.sentAt && !comment.resolvedAt && mulch?.nodes[comment.nodeId]);
}

function clock(at: number): string {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** On a card: how many comments are open (always shown when there are some), and a way to add one. */
export function CommentControl({ nodeId, selected }: { nodeId: string; selected: boolean }) {
  const open = useMulch((s) => commentsOn(s.mulch, nodeId).filter((comment) => !comment.resolvedAt).length);
  const any = useMulch((s) => commentsOn(s.mulch, nodeId).length > 0);
  const show = useComments((s) => s.show);
  // Without comments it shows on hover and when the card is selected.
  const hidden = !any && !selected ? "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : "";
  return (
    <button
      onClick={(event) => {
        event.stopPropagation();
        const box = (event.currentTarget.closest(".react-flow__node") as HTMLElement | null)?.getBoundingClientRect();
        show({ nodeId, x: (box?.right ?? event.clientX) + 8, y: box?.top ?? event.clientY });
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className={`nodrag absolute -top-3 -right-3 z-10 h-6 min-w-6 px-1 rounded-full inline-flex items-center justify-center gap-0.5 text-[11px] font-medium tabular-nums shadow-sm ${hidden} ${open ? "bg-ink text-white" : "bg-chrome text-ink-2 border border-line hover:text-ink"}`}
      aria-label="Comments"
      title="Comments"
    >
      <MessageSquare size={11} strokeWidth={2} />
      {open > 0 && open}
    </button>
  );
}

/** The open item's comments and a field for a new one, over the canvas. */
export function CommentPanel() {
  const open = useComments((s) => s.open);
  const show = useComments((s) => s.show);
  const mulch = useMulch((s) => s.mulch);
  const apply = useMulch((s) => s.apply);
  const [text, setText] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const node = open ? mulch?.nodes[open.nodeId] : undefined;

  useEffect(() => setText(""), [open?.nodeId]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) show(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") show(undefined);
    };
    // After the click that opened it.
    const timer = setTimeout(() => window.addEventListener("mousedown", close), 0);
    window.addEventListener("keydown", escape);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open, show]);

  if (!open || !node || !mulch) return null;
  const comments = commentsOn(mulch, node.id);
  const add = () => {
    const value = text.trim();
    if (!value) return;
    apply([{ op: "addComment", comment: { id: newClientId("c"), nodeId: node.id, text: value, ...(open.at ? { at: open.at } : {}), createdAt: Date.now() } }]);
    setText("");
  };
  const width = 300;
  const left = Math.max(8, Math.min(open.x, window.innerWidth - width - 8));
  const top = Math.max(60, Math.min(open.y, window.innerHeight - 320));
  return (
    <div ref={panel} className="float fixed z-40 rounded-xl p-2 text-[13px]" style={{ left, top, width }} onMouseDown={(event) => event.stopPropagation()}>
      {comments.length > 0 && (
        <ul className="max-h-[40vh] overflow-auto space-y-1.5 mb-2">
          {comments.map((comment) => (
            <li key={comment.id} className={`group/comment rounded-lg px-2.5 py-1.5 ${comment.resolvedAt ? "bg-paper-2 text-ink-3" : "bg-paper-2 text-ink"}`}>
              <div className="flex items-start gap-1.5">
                <p className="flex-1 whitespace-pre-wrap break-words leading-snug">{comment.text}</p>
                {!comment.sentAt && !comment.resolvedAt && (
                  <button onClick={() => apply([{ op: "removeComment", id: comment.id }])} className="shrink-0 p-0.5 rounded text-ink-3 opacity-0 group-hover/comment:opacity-100 hover:text-ink" aria-label="Delete" title="Delete">
                    <X size={12} strokeWidth={2} />
                  </button>
                )}
              </div>
              <div className="mt-0.5 text-[11.5px] text-ink-3 tabular-nums">
                {comment.at?.slide ? `Slide ${comment.at.slide}, ` : ""}
                {clock(comment.createdAt)}
              </div>
              {comment.resolution && <p className="mt-1 text-[12px] text-ink-2 leading-snug">→ {comment.resolution}</p>}
            </li>
          ))}
        </ul>
      )}
      <textarea
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            add();
          }
          if (event.key === "Escape") show(undefined);
        }}
        rows={2}
        placeholder="Comment"
        aria-label="Comment"
        className="w-full resize-none rounded-lg bg-chrome border border-line px-2.5 py-1.5 outline-none focus:border-ink-3 field-sizing-content max-h-40 placeholder:text-ink-3"
      />
    </div>
  );
}
