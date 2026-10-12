/**
 * Shared files: names, types and the sandbox they are served in.
 *
 * Everything a share holds was made or gathered by an AI on someone's Mac, so
 * it is untrusted. HTML and SVG get the same sandbox as in the app
 * (src/lib/artifacts/artifacts.ts ARTIFACT_CSP; a test keeps the two in
 * step): an opaque origin, scripts and styles inline or from a few CDNs, no
 * network, popups, forms or navigation. The one addition: files from the
 * share itself, so a page can show its own images.
 */

const CDNS = "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com";

/** The app's artifact sandbox, with the share's own files allowed where `own` is given. */
export function sandboxCsp(own: string[] = []): string {
  const self = own.join(" ");
  const with_ = (base: string) => (self ? `${base} ${self}` : base);
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS}`,
    `style-src 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
    `font-src data: ${CDNS} https://fonts.gstatic.com`,
    with_("img-src data: blob:"),
    with_("media-src data: blob:"),
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/** Where a share's files are reachable on the share host, as CSP sources. */
export function ownSources(shareOrigin: string, id: string): string[] {
  return [`${shareOrigin}/s/${id}/`, `${shareOrigin}/api/mulches/${id}/`];
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  svg: "image/svg+xml",
  md: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  json: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  glb: "model/gltf-binary",
};

export function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  return name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
}

/** The type a shared file is served as. Decided by its name, never by what the uploader said. */
export function mimeOf(path: string): string {
  return MIME[extensionOf(path)] ?? "application/octet-stream";
}

/** Office files download; everything else opens in the browser. */
export function downloads(path: string): boolean {
  return ["pptx", "docx", "xlsx"].includes(extensionOf(path));
}

/** Files are named like `assets/ab12.png`, `artifacts/deck.html`: no dot segments, no leading slash. */
export function validPath(path: string): boolean {
  if (!path || path.length > 300) return false;
  return path.split("/").every((segment) => /^[A-Za-z0-9_-][A-Za-z0-9._ -]*$/.test(segment) && !segment.startsWith("."));
}

/** Headers for serving a shared file. */
export function fileHeaders(path: string, csp: string, size?: number): Headers {
  const headers = new Headers({
    "Content-Type": mimeOf(path),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-cache",
  });
  // The browser's own PDF viewer does not run inside a CSP sandbox; it isolates PDFs itself.
  if (extensionOf(path) !== "pdf") headers.set("Content-Security-Policy", csp);
  if (size !== undefined) headers.set("Content-Length", String(size));
  if (downloads(path)) headers.set("Content-Disposition", `attachment; filename="${(path.split("/").pop() ?? "file").replace(/"/g, "")}"`);
  return headers;
}
