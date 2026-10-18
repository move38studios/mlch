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
  "base", "fast", "call", "slow", ...ENRICHMENTS.map((e) => `enrich:${e}` as const), "command", "research", "maker", "ingest", "image", "folder",
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
  /**
   * How each AI is paid for: the person's own subscription login on this Mac,
   * or an API key (Keychain: "anthropic", "openai") billed to their API account.
   */
  agentAuth: z
    .object({ claude: z.enum(["subscription", "apiKey"]).default("subscription"), codex: z.enum(["subscription", "apiKey"]).default("subscription") })
    .default({ claude: "subscription", codex: "subscription" }),
  /**
   * mlch is an interface on the person's own Claude Code / Codex: their settings, CLAUDE.md /
   * AGENTS.md, MCP servers and connectors apply to their instructions, research and making.
   * Off: mlch's own tools only. docs/research/connectors.md.
   */
  agentSetup: z.boolean().default(true),
  /**
   * What instructions, research and making may do on this Mac: auto (the CLI's own tools, a
   * classifier approves each action and asks the person when it cannot decide), ask (anything
   * the person's rules don't allow asks first), sandboxed (writes only in the mulch, network only
   * to package registries, instructions without a shell).
   */
  access: z.enum(["auto", "ask", "sandboxed"]).default("auto"),
  /** When the person confirmed using their own subscription (ms), per AI. */
  subscriptionConsent: z.object({ claude: z.number().optional(), codex: z.number().optional() }).default({}),
  enrich: z.array(z.enum(ENRICHMENTS)).default([...ENRICHMENTS]),
  /** The person's own wording for prompt parts. Absent: the default. */
  prompts: z
    .object(Object.fromEntries(PROMPT_KEYS.map((key) => [key, z.string().max(20_000).optional()])) as Record<PromptKey, z.ZodOptional<z.ZodString>>)
    .default({}),
  /**
   * The person's house style for what the AI makes (decks, documents, pages, images): brand,
   * colours, fonts, tone, a logo's path on this Mac. Absent: mlch's default look (prompts.ts
   * DEFAULT_HOUSE_STYLE); empty: none, each thing is designed to suit its content.
   */
  style: z.string().max(20_000).optional(),
  /** The person emptied the style on purpose (an empty style from before the default existed means unset). */
  styleCleared: z.boolean().optional(),
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
  /** The first-run checklist was finished (or the library was in use before it existed). */
  onboarded: z.boolean().default(false),
  /** The "Start here" mulch was made (once per library, even if deleted later). */
  startHere: z.boolean().default(false),
  /**
   * Where shared links live: mlch.app (sign in, subscription), nowhere (no Share buttons, nothing sent),
   * or the person's own mlch server (`shareServer`; its key in Keychain as "shareKey").
   */
  sharing: z.enum(["mlch", "off", "own"]).default("mlch"),
  shareServer: z.string().max(500).optional(),
  /** Random id for this install, sent when creating share links (they are counted per install). */
  installId: z.string().max(64).optional(),
  /** Speech to text: Groq Whisper (key) or Parakeet on this Mac (native helper). */
  transcription: z.enum(["groq", "local"]).default("local"),
  /** Paid generation (fal) stops for the day at this many US dollars. */
  dailySpendCapUsd: z.number().min(0).max(1000).default(10),
});

export type Settings = z.infer<typeof settingsSchema>;
export type Lane = "fast" | "slow" | "command";

/**
 * By how often a lane runs: capture (every utterance) fast; enrichment (every
 * batch) strong; instructions, making and research (rare, and what mlch is
 * judged by) the strongest. A Codex model the account doesn't list falls back
 * to Codex's default (codexHarness `resolveModel`).
 */
export const DEFAULT_MODELS: Record<AgentHarnessId, Record<Lane, string | undefined>> = {
  claude: { fast: "haiku", slow: "sonnet", command: "opus" },
  codex: { fast: "gpt-6.1-sol", slow: "gpt-6-astra", command: "gpt-6-astra" },
};

function file(): string {
  return path.join(libraryDir(), ".settings.json");
}

export async function readSettings(): Promise<Settings> {
  try {
    return normalize(settingsSchema.parse(JSON.parse(await fs.readFile(file(), "utf8"))));
  } catch {
    return settingsSchema.parse({});
  }
}

/** An empty style is "none" only when the person cleared it; otherwise mlch's default applies. */
function normalize(settings: Settings): Settings {
  if (settings.style !== undefined && !settings.style.trim() && !settings.styleCleared) return { ...settings, style: undefined };
  return settings;
}

export async function writeSettings(patch: unknown): Promise<Settings> {
  const current = await readSettings();
  const merged: Record<string, unknown> = { ...current, ...(patch as object) };
  // null resets a setting to its default (the style).
  for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key];
  const next = normalize(settingsSchema.parse(merged));
  await atomicWriteFile(file(), JSON.stringify(next, null, 2));
  return next;
}

export function modelFor(settings: Settings, lane: Lane): string | undefined {
  return settings.models[settings.harness][lane] || DEFAULT_MODELS[settings.harness][lane];
}
