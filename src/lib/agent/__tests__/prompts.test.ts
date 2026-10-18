// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { JobStatus } from "@/lib/mulch/events";
import { settingsSchema } from "@/lib/settings";
import { commandPrompt, DEFAULT_HOUSE_STYLE, EARLIER_MAX, earlierExchanges, fastPrompt, makerPrompt, PROMPT_DEFAULTS, slowPrompt } from "../prompts";

describe("prompts", () => {
  it("uses the defaults when nothing is edited", () => {
    const settings = settingsSchema.parse({});
    expect(fastPrompt(settings)).toBe(`${PROMPT_DEFAULTS.base}\n\n${PROMPT_DEFAULTS.fast}`);
  });

  it("uses the person's wording, and the default again for blank text", () => {
    const settings = settingsSchema.parse({ prompts: { fast: "Capture tersely.", base: "   " } });
    expect(fastPrompt(settings)).toBe(`${PROMPT_DEFAULTS.base}\n\nCapture tersely.`);
  });

  it("lists only the chosen enrichments, and leaves out search without the web", () => {
    const settings = settingsSchema.parse({ enrich: ["search", "examples"], prompts: { "enrich:examples": "Examples please." } });
    const offline = slowPrompt(settings, false);
    expect(offline).toContain("- Examples please.");
    expect(offline).not.toContain(PROMPT_DEFAULTS["enrich:search"]);
    expect(slowPrompt(settings, true)).toContain(PROMPT_DEFAULTS["enrich:search"]);
  });

  it("keeps the hand-over instructions for the maker whatever the edit", () => {
    const settings = settingsSchema.parse({ harness: "codex", prompts: { maker: "Make it nice." }, style: "" });
    expect(makerPrompt(settings)).toMatch(/^Make it nice\.\n\nYour shell and files work as in the person's Terminal[^\n]*\n\nSave finished files/);
    // Sandboxed: what the shell can't reach, so briefs don't ask for it.
    expect(makerPrompt(settingsSchema.parse({ harness: "codex", access: "sandboxed" }))).toContain("reach only package registries (no websites");
  });

  it("gives instructions Claude Code's own tools unless sandboxed (and only on Claude)", () => {
    expect(commandPrompt(settingsSchema.parse({ harness: "claude" }))).toContain("Claude Code's own tools on this Mac");
    expect(commandPrompt(settingsSchema.parse({ harness: "claude", access: "sandboxed" }))).not.toContain("Claude Code's own tools on this Mac");
    expect(commandPrompt(settingsSchema.parse({ harness: "codex" }))).not.toContain("Claude Code's own tools on this Mac");
  });

  it("starts with mlch's house style; a cleared one is none, the maker gets file places", () => {
    expect(commandPrompt(settingsSchema.parse({}))).toContain(DEFAULT_HOUSE_STYLE);
    expect(commandPrompt(settingsSchema.parse({ style: "", styleCleared: true }))).not.toContain("<house_style>");
    expect(commandPrompt(settingsSchema.parse({ style: "Green and gold." }))).toContain("Green and gold.");
    const maker = makerPrompt(settingsSchema.parse({}));
    expect(maker).not.toContain("{{file:mlch:");
    expect(maker).toMatch(/public\/fonts\/SchibstedGrotesk\.woff2/);
  });

  describe("earlierExchanges", () => {
    const now = Date.UTC(2026, 9, 15, 15, 35);
    const job = (id: string, minutesAgo: number, extra: Partial<JobStatus> = {}): JobStatus => ({
      id,
      lane: "command",
      state: "done",
      label: id,
      queuedAt: now - minutesAgo * 60_000,
      finishedAt: now - minutesAgo * 60_000 + 30_000,
      retry: { kind: "command", input: `instruction ${id}` },
      ...extra,
    });

    it("is empty with nothing before", () => {
      expect(earlierExchanges([])).toBe("");
    });

    it("lists earlier instructions oldest first with what came of each", () => {
      const text = earlierExchanges(
        [
          job("b", 5, { message: { text: "I can't get into your email.", at: now } }),
          job("a", 30, { resultIds: ["n1", "n2"] }),
          job("c", 2, { state: "failed", error: "Timed out." }),
        ],
      );
      expect(text).toContain("<earlier>");
      expect(text.indexOf("instruction a")).toBeLessThan(text.indexOf("instruction b"));
      expect(text.indexOf("instruction b")).toBeLessThan(text.indexOf("instruction c"));
      expect(text).toContain("You told them: I can't get into your email.");
      expect(text).toContain("Done: 2 item(s) added (n1, n2).");
      expect(text).toContain("Failed: Timed out.");
    });

    it("leaves out the current job, running ones and other work, but not old ones", () => {
      const text = earlierExchanges(
        [
          job("current", 0),
          job("running", 1, { state: "running", finishedAt: undefined }),
          job("old", 7 * 60),
          job("speech", 1, { retry: undefined }),
          job("notes", 1, { retry: { kind: "callNotes", input: "transcript" } }),
          job("kept", 3),
        ],
        "current",
      );
      expect(text).toContain("instruction kept");
      expect(text).toContain("instruction old");
      for (const id of ["current", "running", "speech", "notes"]) expect(text).not.toContain(`instruction ${id}`);
    });

    it("keeps only the most recent few", () => {
      const jobs = Array.from({ length: EARLIER_MAX + 3 }, (_, i) => job(`j${i}`, 60 - i));
      const text = earlierExchanges(jobs);
      expect(text).not.toContain("instruction j0\n");
      expect(text).toContain(`instruction j${EARLIER_MAX + 2}`);
      expect(text.match(/\] Instruction:/g)).toHaveLength(EARLIER_MAX);
    });
  });
});
