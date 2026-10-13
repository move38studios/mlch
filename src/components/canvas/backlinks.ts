"use client";

/** Link cards in other mulches that point into this one, fetched once per mulch and again when the window comes back. */

import { useEffect, useState } from "react";
import type { Backlink } from "@/lib/links/links";

export function useBacklinks(mulchId: string | undefined): Backlink[] {
  const [links, setLinks] = useState<{ mulchId: string; links: Backlink[] }>();
  useEffect(() => {
    if (!mulchId) return;
    let cancelled = false;
    const load = () =>
      fetch(`/api/mulches/${mulchId}/backlinks`)
        .then((response) => (response.ok ? (response.json() as Promise<{ backlinks: Backlink[] }>) : undefined))
        .then((body) => !cancelled && body && setLinks({ mulchId, links: Array.isArray(body.backlinks) ? body.backlinks : [] }))
        .catch(() => {});
    void load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [mulchId]);
  return links && links.mulchId === mulchId ? links.links : [];
}
