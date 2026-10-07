/**
 * Subscription usage, per day, in .usage.json in the library. Server-only.
 *
 * Turns run on the person's Claude or ChatGPT plan, so they cost no money
 * per token, but they draw on the plan's limits; this keeps a record to show
 * next to paid generation spend.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { libraryDir } from "@/lib/desktop/server";
import { atomicWriteFile } from "@/lib/mulch/store";
import { today } from "@/lib/media/spend";

export interface UsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

type Ledger = Record<string, Record<string, UsageTotals>>;

function file(): string {
  return path.join(libraryDir(), ".usage.json");
}

async function read(): Promise<Ledger> {
  try {
    return JSON.parse(await fs.readFile(file(), "utf8")) as Ledger;
  } catch {
    return {};
  }
}

let chain: Promise<unknown> = Promise.resolve();

/** Adds one usage report; key is "<harness>/<lane>". */
export function recordUsage(harness: string, lane: string, inputTokens: number, outputTokens: number): Promise<void> {
  const next = chain.then(async () => {
    const data = await read();
    const day = (data[today()] ??= {});
    const entry = (day[`${harness}/${lane}`] ??= { turns: 0, inputTokens: 0, outputTokens: 0 });
    entry.turns += 1;
    entry.inputTokens += inputTokens;
    entry.outputTokens += outputTokens;
    await atomicWriteFile(file(), JSON.stringify(data, null, 2));
  });
  chain = next.catch(() => {});
  return next;
}

export async function usageToday(): Promise<Record<string, UsageTotals>> {
  return (await read())[today()] ?? {};
}
