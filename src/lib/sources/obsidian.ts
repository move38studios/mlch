/**
 * Markdown notes as Obsidian writes them: frontmatter, #tags and [[wikilinks]].
 * Pure; used for any linked folder, and for vaults (a `.obsidian` folder) to
 * open notes in Obsidian.
 */

export interface ParsedNote {
  /** Frontmatter `title`, else undefined (the file name stands in). */
  title?: string;
  tags: string[];
  /** Wikilink targets, without aliases or headings, in order, unique. */
  links: string[];
  /** The text without its frontmatter. */
  body: string;
}

function listValue(raw: string): string[] {
  const inline = raw.trim();
  if (inline.startsWith("[")) return inline.slice(1, -1).split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  return inline ? inline.split(/[,\s]+/).map((v) => v.replace(/^#/, "")).filter(Boolean) : [];
}

export function parseNote(text: string): ParsedNote {
  let body = text;
  let title: string | undefined;
  const tags = new Set<string>();
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (front) {
    body = text.slice(front[0].length);
    const lines = front[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
      if (!match) continue;
      const [, key, value] = match;
      if (key === "title" && value.trim()) title = value.trim().replace(/^["']|["']$/g, "");
      if (key === "tags" || key === "tag") {
        if (value.trim()) listValue(value).forEach((t) => tags.add(t));
        // A YAML list on the following lines.
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) tags.add(lines[++i].replace(/^\s*-\s+/, "").trim().replace(/^#/, ""));
      }
    }
  }
  // Inline #tags, not inside code and not headings ("# Title").
  const withoutCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  for (const match of withoutCode.matchAll(/(^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) tags.add(match[2]);
  const links: string[] = [];
  for (const match of withoutCode.matchAll(/!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const target = match[1].trim();
    if (target && !links.includes(target)) links.push(target);
  }
  return { ...(title ? { title } : {}), tags: [...tags], links, body };
}

/** obsidian:// link that opens a note in its vault (the vault's folder name is its name). */
export function obsidianUrl(vaultName: string, relativePath: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relativePath.replace(/\.md$/i, ""))}`;
}
