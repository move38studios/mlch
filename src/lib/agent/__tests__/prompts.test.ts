// @vitest-environment node
import { describe, expect, it } from "vitest";
import { settingsSchema } from "@/lib/settings";
import { commandPrompt, DEFAULT_HOUSE_STYLE, fastPrompt, makerPrompt, PROMPT_DEFAULTS, slowPrompt } from "../prompts";

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
    expect(makerPrompt(settings)).toMatch(/^Make it nice\.\n\nSave finished files/);
  });

  it("starts with mlch's house style; a cleared one is none, the maker gets file places", () => {
    expect(commandPrompt(settingsSchema.parse({}))).toContain(DEFAULT_HOUSE_STYLE);
    expect(commandPrompt(settingsSchema.parse({ style: "", styleCleared: true }))).not.toContain("<house_style>");
    expect(commandPrompt(settingsSchema.parse({ style: "Green and gold." }))).toContain("Green and gold.");
    const maker = makerPrompt(settingsSchema.parse({}));
    expect(maker).not.toContain("{{file:mlch:");
    expect(maker).toMatch(/public\/fonts\/SchibstedGrotesk\.woff2/);
  });
});
