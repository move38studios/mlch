import fs from "node:fs/promises";
import path from "node:path";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

/** onnxruntime-web's WebAssembly runtime, for voice detection in the page (src/lib/voice/vad.ts). */
const FILES: Record<string, string> = {
  "ort-wasm-simd-threaded.wasm": "application/wasm",
  "ort-wasm-simd-threaded.mjs": "text/javascript",
};

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const type = FILES[file];
  if (!type) return jsonError(404, "Not found.");
  const bytes = await fs.readFile(path.join(process.cwd(), "node_modules", "onnxruntime-web", "dist", file)).catch(() => undefined);
  if (!bytes) return jsonError(404, "Not found.");
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400" } });
}
