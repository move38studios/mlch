"use client";

import { useEffect, useState } from "react";
import { artifactKindOf, type ArtifactKind } from "@/lib/artifacts/kind";
import type { MulchNode } from "@/lib/mulch/types";

/** Kinds read from files that do not carry one on their card (older ones, the maker lane's), by address. */
const read = new Map<string, Promise<ArtifactKind>>();

function readKind(src: string): Promise<ArtifactKind> {
  let kind = read.get(src);
  if (!kind) {
    kind = fetch(src)
      .then((response) => (response.ok ? response.text() : ""))
      .then((html) => artifactKindOf(html))
      .catch(() => "page" as const);
    read.set(src, kind);
  }
  return kind;
}

/**
 * Whether an HTML or SVG card is a deck or a page: from the card, else from
 * the file itself (the same address the frame shows, so it works in a share).
 * Undefined while it is being read.
 */
export function useArtifactKind(node: Pick<MulchNode, "artifactKind" | "docPath" | "updatedAt" | "createdAt"> | undefined, src: string | undefined): ArtifactKind | undefined {
  const known = node?.artifactKind ?? (node?.docPath && !node.docPath.endsWith(".html") ? "page" : undefined);
  const key = src && !known ? `${src}?v=${node?.updatedAt ?? node?.createdAt ?? 0}` : undefined;
  const [found, setFound] = useState<{ key: string; kind: ArtifactKind }>();
  useEffect(() => {
    if (!key) return;
    let live = true;
    void readKind(key).then((kind) => live && setFound({ key, kind }));
    return () => {
      live = false;
    };
  }, [key]);
  if (known) return known;
  return found && found.key === key ? found.kind : undefined;
}
