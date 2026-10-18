/**
 * Files the AI makes for a mulch, in its artifacts/ folder. Server-only.
 *
 * HTML artifacts are shown inside the app, so they are served with a
 * sandboxing Content-Security-Policy: an opaque origin (no access to the
 * app or its API), scripts and styles only inline or from a few CDNs, images
 * only inline, and no network requests, popups or forms. Artifact content
 * can be shaped by web pages the agent read, so it is treated as untrusted.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, mulchDir } from "@/lib/mulch/store";
import { withPlayer } from "./deck";

export const ARTIFACT_EXTENSIONS = ["html", "svg", "md", "csv", "json", "txt", "pptx", "pdf", "docx", "xlsx", "png", "jpg"] as const;
export const ARTIFACT_PATH = new RegExp(`^artifacts\\/[a-z0-9][a-z0-9._-]*\\.(${ARTIFACT_EXTENSIONS.join("|")})$`);

const CDNS = "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com";

export const ARTIFACT_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS}`,
  `style-src 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
  `font-src data: ${CDNS} https://fonts.gstatic.com`,
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export const ARTIFACT_MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml",
  md: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  json: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
};

/** Files shown inside the app rather than opened in another app. */
export const VIEWABLE = new Set(["html", "svg", "png", "jpg", "pdf"]);

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "file"
  );
}

/** Saves under a free name; returns the path relative to the mulch folder. */
export async function saveArtifact(mulchId: string, title: string, extension: string, bytes: Buffer): Promise<string> {
  const dir = path.join(mulchDir(mulchId), "artifacts");
  await fs.mkdir(dir, { recursive: true });
  const existing = new Set(await fs.readdir(dir).catch(() => [] as string[]));
  let name = `${slugify(title)}.${extension}`;
  for (let i = 2; existing.has(name); i++) name = `${slugify(title)}-${i}.${extension}`;
  await atomicWriteFile(path.join(dir, name), bytes);
  return `artifacts/${name}`;
}

export function artifactFile(mulchId: string, docPath: string): string {
  if (!ARTIFACT_PATH.test(docPath)) throw new Error("Invalid file.");
  return path.join(mulchDir(mulchId), docPath);
}

/**
 * Give a file the agent wrote in artifacts/ a safe name (lowercase, no
 * spaces) and return its mulch-relative path, or undefined if it is not an
 * artifact type or not inside artifacts/.
 */
export async function adoptArtifact(mulchId: string, file: string): Promise<string | undefined> {
  const dir = path.join(mulchDir(mulchId), "artifacts");
  const resolved = path.resolve(dir, file);
  if (path.dirname(resolved) !== dir) return undefined;
  const ext = path.extname(resolved).slice(1).toLowerCase();
  if (!(ARTIFACT_EXTENSIONS as readonly string[]).includes(ext)) return undefined;
  const stat = await fs.stat(resolved).catch(() => undefined);
  if (!stat?.isFile()) return undefined;
  const base = slugify(path.basename(resolved, path.extname(resolved)));
  let name = `${base}.${ext}`;
  if (`${dir}/${name}` !== resolved) {
    const existing = new Set(await fs.readdir(dir));
    for (let i = 2; existing.has(name); i++) name = `${base}-${i}.${ext}`;
    await fs.rename(resolved, path.join(dir, name));
  }
  // A deck the maker wrote in mlch's format gets the player.
  if (ext === "html") {
    const file = path.join(dir, name);
    const html = await fs.readFile(file, "utf8").catch(() => undefined);
    const played = html ? withPlayer(html) : undefined;
    if (html && played && played !== html) await fs.writeFile(file, played);
  }
  return `artifacts/${name}`;
}
