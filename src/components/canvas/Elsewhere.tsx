"use client";

import Link from "next/link";
import { useCallback, useEffect } from "react";
import { X } from "lucide-react";
import { create } from "zustand";
import { Scribble } from "@/components/brand/Scribble";
import { useMulch } from "@/lib/mulch/client";
import type { JobActivity } from "@/lib/mulch/events";

interface Other {
  id: string;
  title: string;
  activity: JobActivity;
}

/** The other mulches with the person's work in them, and this mulch's focus mode. */
const useElsewhereState = create<{ mulchId?: string; focus: boolean; others: Other[] }>(() => ({ focus: false, others: [] }));

export type ElsewhereView = ReturnType<typeof useElsewhere>;

/** Loaded once for the mulch screen: refreshed when work changes elsewhere, on focus, and every 30 s. */
export function useElsewhere(mulchId: string) {
  const elsewhereAt = useMulch((s) => s.elsewhereAt);
  const state = useElsewhereState();
  const load = useCallback(async () => {
    const response = await fetch(`/api/mulches/${mulchId}/elsewhere`).catch(() => undefined);
    if (!response?.ok) return;
    const body = (await response.json()) as { focus: boolean; others: Other[] };
    useElsewhereState.setState({ mulchId, focus: body.focus, others: body.others });
  }, [mulchId]);
  useEffect(() => {
    void load();
    // Recent activity ages out of the list.
    const timer = setInterval(() => void load(), 30_000);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [load]);
  useEffect(() => {
    if (elsewhereAt) void load();
  }, [elsewhereAt, load]);
  const setFocus = (focus: boolean) => {
    useElsewhereState.setState({ focus });
    void fetch(`/api/mulches/${mulchId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ focus }) });
  };
  // Until this mulch's own answer is in, show nothing (no flash of the list in focus mode).
  return { ready: state.mulchId === mulchId, focus: state.focus, others: state.others, setFocus };
}

const needsYou = (a: JobActivity) => !!(a.paused || a.waiting || a.unseen);
const rank = (a: JobActivity) => (a.working ? 0 : a.failed ? 1 : needsYou(a) ? 2 : 3);

function Mark({ activity: a }: { activity: JobActivity }) {
  if (a.working) return <Scribble which="bottom" mode="loop" strokeWidth={11} className="h-2.5 w-6 text-ink shrink-0" />;
  const color = a.failed ? "bg-danger" : needsYou(a) ? "bg-amber" : "bg-line-2";
  return (
    <span className="w-6 shrink-0 flex justify-center">
      <span className={`h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

/**
 * Other mulches where the person's work is running, waiting for them, or was
 * active lately, at the left under the title. Closing it puts this mulch in
 * focus mode (kept per mulch): the list stays closed and other mulches'
 * notifications wait while it is open. The count by the title opens it again.
 */
export function Elsewhere({ view }: { view: ElsewhereView }) {
  const { ready, focus, others, setFocus } = view;
  if (!ready || focus || !others.length) return null;
  const sorted = [...others].sort((a, b) => rank(a.activity) - rank(b.activity) || (b.activity.lastAt ?? 0) - (a.activity.lastAt ?? 0));
  return (
    <nav aria-label="Other mulches" className="no-drag absolute left-3 top-[60px] z-10 w-[232px] float rounded-xl py-1 group/elsewhere">
      <button
        onClick={() => setFocus(true)}
        className="absolute right-1 top-1 p-1 rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink"
        aria-label="Close"
        title="Close"
      >
        <X size={12} strokeWidth={2} />
      </button>
      <ul className="max-h-[40vh] overflow-auto">
        {sorted.map((other) => (
          <li key={other.id}>
            <Link href={`/n/${other.id}`} className="flex items-center gap-2 pl-1.5 pr-7 py-1.5 mx-1 rounded-lg text-[13px] text-ink-2 hover:bg-paper-2 hover:text-ink">
              <Mark activity={other.activity} />
              <span className="truncate">{other.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** By the title in focus mode: how many other mulches are active; opens the list again. */
export function ElsewhereCount({ view }: { view: ElsewhereView }) {
  const { ready, focus, others, setFocus } = view;
  if (!ready || !focus || !others.length) return null;
  const any = (test: (a: JobActivity) => boolean) => others.some((other) => test(other.activity));
  const color = any((a) => !!a.failed) ? "bg-danger" : any(needsYou) ? "bg-amber" : any((a) => !!a.working) ? "bg-ink" : "bg-line-2";
  return (
    <button
      onClick={() => setFocus(false)}
      className="ml-0.5 h-7 px-1.5 rounded-lg inline-flex items-center gap-1.5 text-[12.5px] tabular-nums text-ink-3 hover:bg-paper-2 hover:text-ink"
      aria-label="Other mulches"
      title="Other mulches"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      {others.length}
    </button>
  );
}
