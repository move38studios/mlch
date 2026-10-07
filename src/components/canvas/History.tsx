"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import type { Napkin } from "@/lib/napkin/types";

interface Checkpoint {
  at: number;
  kind: "edit" | "job" | "pre-restore" | "restore";
  nodeCount: number;
  label?: string;
}

const KIND_LABEL: Record<Checkpoint["kind"], string> = { edit: "Edits", job: "AI", "pre-restore": "Before restore", restore: "Restored" };

/**
 * The timeline: a slider over checkpoints. Moving it shows that moment
 * (read-only) through `onPreview`; Restore makes it the current napkin.
 */
export function HistoryBar({ napkinId, onPreview, onClose }: { napkinId: string; onPreview(napkin?: Napkin): void; onClose(): void }) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>();
  const [index, setIndex] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const cache = useMemo(() => new Map<number, Napkin>(), []);

  useEffect(() => {
    void fetch(`/api/napkins/${napkinId}/history`)
      .then((r) => r.json())
      .then((body: { checkpoints?: Checkpoint[] }) => {
        const list = body.checkpoints ?? [];
        setCheckpoints(list);
        setIndex(list.length);
      });
  }, [napkinId]);

  // index === checkpoints.length means "now".
  const selected = checkpoints && index < checkpoints.length ? checkpoints[index] : undefined;

  useEffect(() => {
    if (!selected) {
      onPreview(undefined);
      return;
    }
    const cached = cache.get(selected.at);
    if (cached) {
      onPreview(cached);
      return;
    }
    let cancelled = false;
    void fetch(`/api/napkins/${napkinId}/history/${selected.at}`)
      .then((r) => r.json())
      .then((body: { napkin?: Napkin }) => {
        if (!body.napkin) return;
        cache.set(selected.at, body.napkin);
        if (!cancelled) onPreview(body.napkin);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, napkinId, cache, onPreview]);

  async function restore() {
    if (!selected) return;
    setRestoring(true);
    await fetch(`/api/napkins/${napkinId}/history/${selected.at}`, { method: "POST" });
    setRestoring(false);
    onClose();
  }

  return (
    <div className="shrink-0 border-b border-line bg-white px-4 py-2.5 flex items-center gap-4 text-sm z-10">
      <span className="font-medium shrink-0">History</span>
      {checkpoints && checkpoints.length === 0 ? (
        <span className="text-ink-3 flex-1">No checkpoints yet.</span>
      ) : (
        <>
          <input
            type="range"
            min={0}
            max={checkpoints?.length ?? 0}
            value={index}
            onChange={(e) => setIndex(Number(e.target.value))}
            className="flex-1 accent-[var(--accent)]"
            aria-label="Time"
          />
          <span className="w-72 shrink-0 text-ink-2 tabular-nums truncate">
            {selected ? (
              <>
                {formatDateTime(selected.at)} · {KIND_LABEL[selected.kind]}
                {selected.label && selected.kind === "job" ? `: ${selected.label}` : ""} · {selected.nodeCount} items
              </>
            ) : (
              "Now"
            )}
          </span>
          <button
            onClick={restore}
            disabled={!selected || restoring}
            className="shrink-0 px-2.5 py-1 rounded-md bg-ink text-paper disabled:opacity-25"
          >
            Restore
          </button>
        </>
      )}
      <button onClick={onClose} className="p-1 rounded hover:bg-paper-2 text-ink-2" aria-label="Close history" title="Close">
        <X size={15} />
      </button>
    </div>
  );
}
