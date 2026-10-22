// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { corrections, fixHeard, type Word } from "../words";

const word = (term: string, heard: string[] = []): Word => ({ id: term, term, heard, from: "person", at: 1 });

describe("words", () => {
  it("replaces known mishearings as whole words, in any case", () => {
    const words = [word("Fco", ["EFCO", "eff co"]), word("Misha", ["Misa"])];
    expect(fixHeard("I told EFCO and misa about it; efcoin stays.", words)).toBe("I told Fco and Misha about it; efcoin stays.");
    expect(fixHeard("talk to eff co tomorrow", words)).toBe("talk to Fco tomorrow");
    expect(fixHeard("Привет, Misa!", words)).toBe("Привет, Misha!");
  });

  it("learns a name or term from an edit, not from a rewrite or a plain word", () => {
    expect(corrections("we asked EFCO about the pilot", "we asked Fco about the pilot")).toEqual([["EFCO", "Fco"]]);
    expect(corrections("the deck for loud box is late", "the deck for Loudbox is late")).toEqual([["loud box", "Loudbox"]]);
    expect(corrections("we should go", "we must go")).toEqual([]);
    expect(corrections("a short note", "a completely different and much longer sentence about other things")).toEqual([]);
    expect(corrections("same", "same")).toEqual([]);
  });
});

describe("words on disk", () => {
  let library: string;
  beforeEach(() => {
    library = fs.mkdtempSync(path.join(os.tmpdir(), "mlch-words-"));
    process.env.MLCH_LIBRARY = library;
  });
  afterEach(() => fs.rmSync(library, { recursive: true, force: true }));

  it("merges how a word was heard, keeps projects apart, and forgets", async () => {
    const { addWord, readWords, removeWord, wordsFor } = await import("../words");
    await addWord({ term: "Fco", heard: ["EFCO"], from: "correction" });
    await addWord({ term: "fco", heard: ["F co"], from: "edit" });
    await addWord({ term: "Pipi", project: "p-1", from: "person" });
    const all = await readWords();
    expect(all).toHaveLength(2);
    const fco = all.find((w) => w.term.toLowerCase() === "fco")!;
    expect(fco.heard).toEqual(["EFCO", "F co"]);
    expect((await wordsFor()).map((w) => w.term)).toEqual(["fco"]);
    expect((await wordsFor("p-1")).map((w) => w.term).sort()).toEqual(["Pipi", "fco"]);
    expect(JSON.parse(fs.readFileSync(path.join(library, "words.json"), "utf8"))).toHaveLength(2);
    await removeWord(fco.id);
    expect((await readWords()).map((w) => w.term)).toEqual(["Pipi"]);
  });
});
