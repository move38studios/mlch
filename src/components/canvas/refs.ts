"use client";

/** Link cards read their target live: a small shared cache, refreshed when the window comes back. */

import { useEffect, useState } from "react";
import type { NodeRef } from "@/lib/mulch/types";
import type { ResolvedRef } from "@/lib/links/links";

const cache = new Map<string, { value?: ResolvedRef; at: number; pending?: Promise<ResolvedRef | undefined> }>();
const listeners = new Set<() => void>();
const FRESH_MS = 30_000;

export function refKey(ref: NodeRef, full = false): string {
  const base = "mulchId" in ref ? `mulch=${encodeURIComponent(ref.mulchId)}&item=${encodeURIComponent(ref.itemId)}` : `source=${encodeURIComponent(ref.sourceId)}&path=${encodeURIComponent(ref.path)}`;
  return full ? `${base}&full=1` : base;
}

function load(key: string): Promise<ResolvedRef | undefined> {
  const entry = cache.get(key);
  if (entry?.pending) return entry.pending;
  const pending = fetch(`/api/refs?${key}`)
    .then((response) => (response.ok ? (response.json() as Promise<ResolvedRef>) : undefined))
    .catch(() => undefined)
    .then((value) => {
      cache.set(key, { value: value ?? cache.get(key)?.value, at: Date.now() });
      listeners.forEach((listener) => listener());
      return value;
    });
  cache.set(key, { ...entry, at: entry?.at ?? 0, pending });
  return pending;
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    for (const [key, entry] of cache) if (Date.now() - entry.at > 2000 && !entry.pending) void load(key);
  });
}

/** What a link points at, as it is now. */
export function useResolvedRef(ref: NodeRef | undefined, full = false): ResolvedRef | undefined {
  const key = ref ? refKey(ref, full) : undefined;
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!key) return;
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    const entry = cache.get(key);
    if (!entry || (!entry.pending && Date.now() - entry.at > FRESH_MS)) void load(key);
    return () => {
      listeners.delete(listener);
    };
  }, [key]);
  return key ? cache.get(key)?.value : undefined;
}
