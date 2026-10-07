/**
 * Paid generation spend, per day, in .spend.json in the library. Server-only.
 *
 * fal reports prices per unit, not the cost of a run, so cost is estimated
 * before submitting: from the unit price and the input where the unit says
 * how (images, megapixels, seconds, characters), and never below the
 * agent's own estimate.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { libraryDir } from "@/lib/desktop/server";
import { atomicWriteFile } from "@/lib/mulch/store";
import { readSettings } from "@/lib/settings";
import { getPrices } from "./fal";

function file(): string {
  return path.join(libraryDir(), ".spend.json");
}

export function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function ledger(): Promise<Record<string, number>> {
  try {
    return JSON.parse(await fs.readFile(file(), "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function spentToday(): Promise<number> {
  return (await ledger())[today()] ?? 0;
}

/** Serialised so concurrent generations cannot lose an update. */
let chain: Promise<unknown> = Promise.resolve();

export function recordSpend(usd: number): Promise<void> {
  const next = chain.then(async () => {
    const data = await ledger();
    data[today()] = Math.round(((data[today()] ?? 0) + usd) * 10000) / 10000;
    await atomicWriteFile(file(), JSON.stringify(data, null, 2));
  });
  chain = next.catch(() => {});
  return next;
}

const SIZE_PRESETS: Record<string, number> = {
  square: 512 * 512,
  square_hd: 1024 * 1024,
  portrait_4_3: 768 * 1024,
  portrait_16_9: 576 * 1024,
  landscape_4_3: 1024 * 768,
  landscape_16_9: 1024 * 576,
};

function count(input: Record<string, unknown>): number {
  for (const keyName of ["num_images", "num_outputs", "n", "batch_size"]) {
    const value = Number(input[keyName]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 1;
}

function megapixels(input: Record<string, unknown>): number {
  const size = input.image_size;
  if (typeof size === "string" && SIZE_PRESETS[size]) return SIZE_PRESETS[size] / 1e6;
  if (size && typeof size === "object") {
    const { width, height } = size as { width?: number; height?: number };
    if (width && height) return (width * height) / 1e6;
  }
  return 1;
}

function seconds(input: Record<string, unknown>): number {
  for (const keyName of ["duration", "seconds", "length", "duration_seconds", "audio_length"]) {
    const value = parseFloat(String(input[keyName] ?? ""));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 5;
}

function characters(input: Record<string, unknown>): number {
  return ["text", "prompt", "lyrics"].reduce((n, k) => n + (typeof input[k] === "string" ? (input[k] as string).length : 0), 0);
}

/** Estimated cost in USD, or undefined when fal has no price for the endpoint. */
export async function estimateCost(endpoint: string, input: Record<string, unknown>): Promise<{ usd?: number; basis: string }> {
  const price = (await getPrices([endpoint])).get(endpoint);
  if (!price) return { basis: "no price listed" };
  const unit = price.unit.toLowerCase();
  let units = 1;
  if (/megapixel/.test(unit)) units = megapixels(input) * count(input);
  else if (/image/.test(unit)) units = count(input);
  else if (/minute/.test(unit)) units = seconds(input) / 60;
  else if (/second/.test(unit) && !/compute|gpu/.test(unit)) units = seconds(input);
  else if (/1000 char|thousand char|1k char/.test(unit)) units = characters(input) / 1000;
  else if (/char/.test(unit)) units = characters(input);
  else if (/compute|gpu/.test(unit)) return { basis: `$${price.unit_price} per ${price.unit} (depends on run time)` };
  return { usd: Math.round(price.unit_price * units * 10000) / 10000, basis: `$${price.unit_price} per ${price.unit} × ${Math.round(units * 100) / 100}` };
}

/** Refuses when the estimate would take today past the cap. */
export async function checkBudget(usd: number): Promise<{ ok: true } | { ok: false; message: string }> {
  const cap = (await readSettings()).dailySpendCapUsd;
  const spent = await spentToday();
  if (spent + usd > cap) {
    return {
      ok: false,
      message: `This would take today's generation spend to $${(spent + usd).toFixed(2)}, over the daily cap of $${cap.toFixed(2)} ($${spent.toFixed(2)} spent). Ask the person before going further; the cap is in Settings.`,
    };
  }
  return { ok: true };
}
