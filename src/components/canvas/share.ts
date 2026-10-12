"use client";

import { useMulch } from "@/lib/mulch/client";
import type { ShareView } from "@/lib/share/shares";

function notify(message: string, level: "error" | "info" = "info") {
  useMulch.setState({ notice: { level, message, at: Date.now() } });
}

export async function copyLink(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    notify("Link copied");
  } catch {
    notify(url);
  }
}

/** POST a share request; returns the share, or undefined after telling the person what went wrong. */
export async function requestShare(mulchId: string, body: { kind: "mulch" } | { kind: "artifact"; nodeId: string }): Promise<{ share: ShareView; shares: ShareView[] } | undefined> {
  const response = await fetch(`/api/mulches/${mulchId}/shares`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = (await response.json().catch(() => ({}))) as { share?: ShareView; shares?: ShareView[]; error?: string };
  if (!response.ok || !result.share) {
    notify(result.error ?? "Sharing failed.", "error");
    return undefined;
  }
  return { share: result.share, shares: result.shares ?? [] };
}

/** Share one made file and copy its link. */
export async function shareArtifact(mulchId: string, nodeId: string): Promise<void> {
  const result = await requestShare(mulchId, { kind: "artifact", nodeId });
  if (result) await copyLink(result.share.url);
}
