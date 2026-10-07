/**
 * Text out of files, locally. Server-only.
 *
 * PDF (unpdf), DOCX (mammoth), and anything that decodes as text. Other
 * formats return an empty string; Firecrawl (ingest.ts) is tried for those
 * when a key is set.
 */

import fs from "node:fs/promises";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm",
  ".js", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".swift", ".kt",
  ".sh", ".sql", ".css", ".scss", ".toml", ".ini", ".cfg", ".log", ".rtf", ".tex", ".org", ".rst",
]);

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg"]);

/** Max bytes read from a file for extraction. */
const MAX_BYTES = 40 * 1024 * 1024;

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }
  return control / Math.max(1, sample.length) < 0.02;
}

export async function extractFromBuffer(buffer: Buffer, fileName: string): Promise<string> {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: false });
    return (Array.isArray(text) ? text : [text]).map((page, i) => `\n\n--- page ${i + 1} ---\n\n${page}`).join("").trim();
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    return (await mammoth.extractRawText({ buffer })).value.trim();
  }
  if (IMAGE_EXTENSIONS.has(ext)) return "";
  if (TEXT_EXTENSIONS.has(ext) || looksLikeText(buffer)) return buffer.toString("utf8");
  return "";
}

export async function readText(file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error("not a file");
  if (stat.size > MAX_BYTES) throw new Error("file too large");
  const text = await extractFromBuffer(await fs.readFile(file), file);
  if (!text) throw new Error("no text could be extracted");
  return text;
}
