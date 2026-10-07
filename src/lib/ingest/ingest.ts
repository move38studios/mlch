/**
 * Files and links coming into a mulch. Server-only.
 *
 * Files are stored content-addressed in the mulch's assets/ folder as
 * <sha256>.<ext>, with the extracted text beside them as <sha256>.md, so a
 * mulch folder carries everything it shows. Links keep their extracted text
 * the same way, so they survive link rot.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getCredential } from "@/lib/desktop/server";
import { atomicWriteFile, mulchDir } from "@/lib/mulch/store";
import { extractFromBuffer, IMAGE_EXTENSIONS } from "./extract";

export const ASSET_ID = /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/plain; charset=utf-8",
  ".json": "application/json",
};

export function mimeFor(assetId: string): string {
  return MIME[path.extname(assetId).toLowerCase()] ?? "application/octet-stream";
}

export function assetPath(mulchId: string, assetId: string): string {
  if (!ASSET_ID.test(assetId)) throw new Error("Invalid asset id.");
  return path.join(mulchDir(mulchId), "assets", assetId);
}

/** The extracted-text file for an asset. */
export function textAssetId(assetId: string): string {
  return `${assetId.split(".")[0]}.md`;
}

function extensionOf(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 9);
  return ext.length > 1 ? ext : ".bin";
}

export function isImage(fileName: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

export async function saveAsset(mulchId: string, bytes: Buffer, fileName: string): Promise<string> {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const assetId = `${sha}${extensionOf(fileName)}`;
  const file = assetPath(mulchId, assetId);
  try {
    await fs.access(file);
  } catch {
    await atomicWriteFile(file, bytes);
  }
  return assetId;
}

export async function saveText(mulchId: string, assetId: string, text: string): Promise<string> {
  const id = textAssetId(assetId);
  await atomicWriteFile(assetPath(mulchId, id), text);
  return id;
}

/* ── Firecrawl (optional) ──────────────────────────────────────── */

async function firecrawlParse(bytes: Buffer, fileName: string): Promise<string> {
  const key = getCredential("firecrawl");
  if (!key) return "";
  const form = new FormData();
  form.append("options", JSON.stringify({ formats: ["markdown"] }));
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), fileName);
  try {
    const response = await fetch("https://api.firecrawl.dev/v2/parse", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const data = (await response.json().catch(() => ({}))) as { success?: boolean; data?: { markdown?: string } };
    return response.ok && data.success ? String(data.data?.markdown ?? "").trim() : "";
  } catch {
    return "";
  }
}

/**
 * Text from a file: locally first; Firecrawl when that yields little (office
 * formats, scanned PDFs) and a key is set. Empty when nothing worked.
 */
export async function extractFile(bytes: Buffer, fileName: string): Promise<string> {
  if (isImage(fileName)) return "";
  let text = "";
  try {
    text = (await extractFromBuffer(bytes, fileName)).trim();
  } catch {
    text = "";
  }
  if (text.replace(/--- page \d+ ---/g, "").trim().length >= 200) return text;
  return (await firecrawlParse(bytes, fileName)) || text;
}

/* ── links ─────────────────────────────────────────────────────── */

export interface LinkContent {
  url: string;
  title: string;
  /** Short, for the card. */
  summary: string;
  /** Full text, for the agent and the side panel. */
  text: string;
}

/** Pages that came back 200 but are a wall, not the content. */
const BLOCKED = /(verify (that )?you are (a )?human|access denied|enable javascript|captcha|are you a robot|cloudflare ray id|just a moment\.\.\.)/i;

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** Readable text from HTML: drops scripts, styles, nav and markup. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const body = (html.match(/<article[\s\S]*?<\/article>/i) ?? html.match(/<main[\s\S]*?<\/main>/i) ?? html.match(/<body[\s\S]*<\/body>/i))?.[0] ?? html;
  const text = decodeEntities(
    body
      .replace(/<(script|style|noscript|svg|nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return { title, text };
}

function firstWords(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max).replace(/\s\S*$/, "")}…` : clean;
}

async function firecrawlScrape(url: string): Promise<LinkContent | undefined> {
  const key = getCredential("firecrawl");
  if (!key) return undefined;
  try {
    const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown", "summary"], onlyMainContent: true, timeout: 30_000 }),
      signal: AbortSignal.timeout(40_000),
    });
    const data = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { markdown?: string; summary?: string; metadata?: { title?: string; ogTitle?: string } };
    };
    if (!response.ok || !data.success) return undefined;
    const text = String(data.data?.markdown ?? "").trim();
    if (!text || BLOCKED.test(text.slice(0, 2000))) return undefined;
    const meta = data.data?.metadata ?? {};
    return {
      url,
      title: String(meta.title || meta.ogTitle || "").trim().slice(0, 200),
      summary: String(data.data?.summary || firstWords(text, 500)).trim().slice(0, 1200),
      text,
    };
  } catch {
    return undefined;
  }
}

async function plainFetch(url: string): Promise<LinkContent | undefined> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36", Accept: "text/html,application/xhtml+xml,text/plain" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return undefined;
    const type = response.headers.get("content-type") ?? "";
    if (!/text\/|html|xml|json/.test(type)) return undefined;
    const raw = (await response.text()).slice(0, 3_000_000);
    const { title, text } = /html/.test(type) ? htmlToText(raw) : { title: "", text: raw };
    if (text.length < 200 || BLOCKED.test(text.slice(0, 2000))) return undefined;
    return { url, title: title.slice(0, 200), summary: firstWords(text, 500), text };
  } catch {
    return undefined;
  }
}

/** Read a page: Firecrawl when a key is set, else a plain fetch. Undefined when neither got real content. */
export async function readLink(url: string): Promise<LinkContent | undefined> {
  return (await firecrawlScrape(url)) ?? (await plainFetch(url));
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && !/\s/.test(value.trim());
  } catch {
    return false;
  }
}

export async function readAssetText(mulchId: string, assetId: string): Promise<string | undefined> {
  try {
    return await fs.readFile(assetPath(mulchId, textAssetId(assetId)), "utf8");
  } catch {
    return undefined;
  }
}
