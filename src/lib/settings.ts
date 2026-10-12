/**
 * App settings, stored as .settings.json in the mulch library. Server-only.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentHarnessId } from "@/lib/agent/types";
import { libraryDir } from "@/lib/desktop/server";
import { atomicWriteFile } from "@/lib/mulch/store";

export const ENRICHMENTS = ["search", "definitions", "examples", "related", "questions", "mulches"] as const;
export type Enrichment = (typeof ENRICHMENTS)[number];

/** Parts of the agent's prompts the person can rewrite; defaults in agent/prompts.ts. */
export const PROMPT_KEYS = [
  "base", "fast", "slow", ...ENRICHMENTS.map((e) => `enrich:${e}` as const), "command", "research", "maker", "ingest", "image", "folder",
] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];

const lanes = z.object({
  fast: z.string().max(80).optional(),
  slow: z.string().max(80).optional(),
  command: z.string().max(80).optional(),
});

export const settingsSchema = z.object({
  harness: z.enum(["claude", "codex"]).default("claude"),
  /** Model id per lane, per harness. Absent: the harness default. */
  models: z
    .object({ claude: lanes.default({}), codex: lanes.default({}) })
    .default({ claude: {}, codex: {} }),
  enrich: z.array(z.enum(ENRICHMENTS)).default([...ENRICHMENTS]),
  /** The person's own wording for prompt parts. Absent: the default. */
  prompts: z
    .object(Object.fromEntries(PROMPT_KEYS.map((key) => [key, z.string().max(20_000).optional()])) as Record<PromptKey, z.ZodOptional<z.ZodString>>)
    .default({}),
  /**
   * Folders linked once and searched from every mulch (read-only). `auto`:
   * the AI uses them on its own; `asked`: only when the person asks.
   * `writeFolder` (relative to the source): where mlch may add new notes.
   */
  sources: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9]{6,24}$/),
        path: z.string().min(1).max(1000),
        name: z.string().min(1).max(200),
        mode: z.enum(["auto", "asked"]).default("auto"),
        writeFolder: z.string().max(300).optional(),
      }),
    )
    .max(20)
    .default([]),
  /** Random id for this install, sent when creating share links (they are counted per install). */
  installId: z.string().max(64).optional(),
  /** Paid generation (fal) stops for the day at this many US dollars. */
  dailySpendCapUsd: z.number().min(0).max(1000).default(10),
});

export type Settings = z.infer<typeof settingsSchema>;
export type Lane = "fast" | "slow" | "command";

/** Fast lane wants speed; the rest want quality. */
export const DEFAULT_MODELS: Record<AgentHarnessId, Record<Lane, string | undefined>> = {
  claude: { fast: "haiku", slow: "sonnet", command: "sonnet" },
  codex: { fast: undefined, slow: undefined, command: undefined },
};

function file(): string {
  return path.join(libraryDir(), ".settings.json");
}

export async function readSettings(): Promise<Settings> {
  try {
    return settingsSchema.parse(JSON.parse(await fs.readFile(file(), "utf8")));
  } catch {
    return settingsSchema.parse({});
  }
}

export async function writeSettings(patch: unknown): Promise<Settings> {
  const current = await readSettings();
  const next = settingsSchema.parse({ ...current, ...(patch as object) });
  await atomicWriteFile(file(), JSON.stringify(next, null, 2));
  return next;
}

export function modelFor(settings: Settings, lane: Lane): string | undefined {
  return settings.models[settings.harness][lane] || DEFAULT_MODELS[settings.harness][lane];
}
