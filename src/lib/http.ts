/** Small helpers for route handlers. */

import { NextResponse } from "next/server";
import { NapkinNotFoundError } from "@/lib/napkin/store";

export function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

/** Map thrown errors to responses: unknown napkin → 404, anything else → 500. */
export async function handle<T>(work: () => Promise<T>): Promise<NextResponse> {
  try {
    const result = await work();
    return result instanceof NextResponse ? result : NextResponse.json(result ?? { ok: true });
  } catch (error) {
    if (error instanceof NapkinNotFoundError) return jsonError(404, error.message);
    console.error(error);
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}
