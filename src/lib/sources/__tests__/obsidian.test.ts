import { describe, expect, it } from "vitest";
import { obsidianUrl, parseNote } from "../obsidian";

describe("parseNote", () => {
  it("reads frontmatter, tags and wikilinks", () => {
    const note = parseNote(`---
title: "Forest cities"
tags: [urbanism, "trees"]
---
# Heading

Cities as forests, see [[Biophilia|biophilic design]] and [[Jane Jacobs#Streets]]. #idea #2026/plan
\`#notatag\` ![[diagram.png]] [[Biophilia]]
`);
    expect(note.title).toBe("Forest cities");
    expect(note.tags).toEqual(expect.arrayContaining(["urbanism", "trees", "idea", "2026/plan"]));
    expect(note.tags).not.toContain("notatag");
    expect(note.tags).not.toContain("Heading");
    expect(note.links).toEqual(["Biophilia", "Jane Jacobs", "diagram.png"]);
    expect(note.body.startsWith("# Heading")).toBe(true);
  });

  it("reads YAML list tags and works without frontmatter", () => {
    expect(parseNote("---\ntags:\n  - one\n  - two\n---\nbody").tags).toEqual(["one", "two"]);
    expect(parseNote("plain text").title).toBeUndefined();
  });

  it("builds Obsidian links without the .md", () => {
    expect(obsidianUrl("My Vault", "Ideas/Forest cities.md")).toBe("obsidian://open?vault=My%20Vault&file=Ideas%2FForest%20cities");
  });
});
