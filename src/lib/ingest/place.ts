/** Adding dropped things to a mulch and reading them in the background. Server-only. */

import { log } from "@/lib/log";
import path from "node:path";
import { submitImage, submitIngest } from "@/lib/agent/jobs";
import { newClientId } from "@/lib/mulch/ids";
import { NODE_WIDTH } from "@/lib/mulch/sizes";
import { applyToMulch, emit } from "@/lib/mulch/store";
import type { MulchNode, NodeKind } from "@/lib/mulch/types";
import { assetPath, extractFile, isImage, readLink, saveAsset, saveText } from "./ingest";
import { fetchFile, fetchImage, FILE_EXTENSION } from "./fetchFile";
import { videoEmbed } from "./video";
import { geminiAvailable, watchVideo } from "@/lib/media/gemini";
import { mediaInfo } from "@/lib/voice/local";
import { readingNote, readVideoFile, transcribeMedia } from "@/lib/media/watch";

const MEDIA_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac", ".aac": "audio/aac",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
};

/** Audio or video, by its name. */
export function mediaType(fileName: string): string | undefined {
  return MEDIA_TYPES[path.extname(fileName).toLowerCase()];
}

/** A recording's length, when the helper can read it (for Groq's pieces). */
async function lengthOf(file: string): Promise<number> {
  return (await mediaInfo(file).catch(() => undefined))?.duration ?? 0;
}

/** Card text for a document: its opening, enough to recognise it. */
const EXCERPT = 600;

function excerpt(text: string): string {
  const clean = text.replace(/--- page \d+ ---/g, "").replace(/\s+/g, " ").trim();
  return clean.length > EXCERPT ? `${clean.slice(0, EXCERPT).replace(/\s\S*$/, "")}…` : clean;
}

async function addNode(mulchId: string, kind: NodeKind, at: { x: number; y: number }, fields: Partial<MulchNode>): Promise<MulchNode> {
  const node: MulchNode = {
    id: newClientId("n"),
    kind,
    x: Math.round(at.x - NODE_WIDTH[kind] / 2),
    y: Math.round(at.y - 40),
    text: "",
    origin: "user",
    createdAt: Date.now(),
    ...fields,
  };
  await applyToMulch(mulchId, [{ op: "addNode", node }], "user");
  return node;
}

function failed(mulchId: string, nodeId: string, message: string) {
  void applyToMulch(mulchId, [{ op: "updateNode", id: nodeId, patch: { text: message } }], "ingest");
}

/** `extra`: fields for the card (the AI's own origin, a caption it wrote, where the file came from). */
export async function addFile(mulchId: string, bytes: Buffer, fileName: string, at: { x: number; y: number }, extra: Partial<MulchNode> = {}): Promise<MulchNode> {
  const assetId = await saveAsset(mulchId, bytes, fileName);
  const name = path.basename(fileName).slice(0, 200);
  if (isImage(fileName)) {
    const node = await addNode(mulchId, "image", at, { assetId, fileName: name, ...extra });
    // A picture with no caption yet is looked at and described.
    if (!extra.text) submitImage(mulchId, node.id, `Looking at ${name}`);
    return node;
  }
  const mime = mediaType(fileName);
  if (mime?.startsWith("video/")) {
    // A video: played in place; Gemini watches it, or what is said is transcribed and the AI looks at its pictures.
    const node = await addNode(mulchId, "media", at, { assetId, fileName: name, title: name, mime, text: "Watching…", ...extra });
    void (async () => {
      const reading = await readVideoFile(assetPath(mulchId, assetId), mime);
      const note = readingNote(reading);
      await saveText(mulchId, assetId, `${reading.text}${note ? `\n\n(${note})` : ""}`);
      const said = reading.text.replace(/^Video[^\n]*\n*/, "").replace(/^What is said:\n/, "").trim();
      await applyToMulch(mulchId, [{ op: "updateNode", id: node.id, patch: { text: [said ? excerpt(said) : "", note].filter(Boolean).join("\n\n") } }], "ingest");
      submitIngest(
        mulchId,
        node.id,
        `Watching ${name}`,
        `Video: ${name} (item ${node.id})\n${note}\n\n${reading.text}` +
          (reading.picturesUnread ? `\n\nIts pictures haven't been looked at yet: call media_view with item ${node.id} to see them in order, and use what is shown (on-screen text, products, people) as well as what is said.` : ""),
        { video: reading.picturesUnread },
      );
    })().catch((error) => {
      log.error("ingest", "video could not be read", { mulchId, fileName, error });
      failed(mulchId, node.id, "This video could not be read.");
    });
    return node;
  }
  if (mime) {
    // A recording: played in place; what is said is read like a document.
    const node = await addNode(mulchId, "media", at, { assetId, fileName: name, title: name, mime, text: "Transcribing…", ...extra });
    void (async () => {
      const file = assetPath(mulchId, assetId);
      let text = "";
      try {
        text = (await transcribeMedia(file, await lengthOf(file), mime)).text.trim();
      } catch (error) {
        return failed(mulchId, node.id, `Nothing could be transcribed: ${error instanceof Error ? error.message : String(error)}.`);
      }
      if (!text) return failed(mulchId, node.id, "No speech was heard in this recording.");
      await saveText(mulchId, assetId, text);
      await applyToMulch(mulchId, [{ op: "updateNode", id: node.id, patch: { text: excerpt(text) } }], "ingest");
      submitIngest(mulchId, node.id, `Listening to ${name}`, `Recording: ${name}\n\nWhat is said:\n${text}`);
    })().catch((error) => {
      log.error("ingest", "recording could not be transcribed", { mulchId, fileName, error });
      failed(mulchId, node.id, "Nothing could be transcribed.");
    });
    return node;
  }
  const node = await addNode(mulchId, "doc", at, { assetId, fileName: name, title: name, text: "Reading…", ...extra });
  void (async () => {
    const text = await extractFile(bytes, fileName);
    if (!text) return failed(mulchId, node.id, "No text could be read from this file.");
    await saveText(mulchId, assetId, text);
    await applyToMulch(mulchId, [{ op: "updateNode", id: node.id, patch: { text: excerpt(text) } }], "ingest");
    submitIngest(mulchId, node.id, `Reading ${name}`, `File: ${name}\n\n${text}`);
  })().catch((error) => {
    log.error("ingest", "file could not be read", { mulchId, fileName, error });
    failed(mulchId, node.id, "No text could be read from this file.");
  });
  return node;
}

export async function addLink(mulchId: string, url: string, at: { x: number; y: number }, extra: Partial<MulchNode> = {}): Promise<MulchNode> {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const video = videoEmbed(url);
  if (video) return addVideoLink(mulchId, url, host, at, extra);
  // An address that points straight at a file: the file itself, like a drop.
  if (FILE_EXTENSION.test(new URL(url).pathname)) {
    const got = await fetchFile(url);
    if (!("error" in got)) {
      const name = decodeURIComponent(path.basename(new URL(url).pathname)).replace(/\.[^.]*$/, "") || host;
      return addFile(mulchId, got.bytes, `${name}${got.extension}`, at, { url, ...extra });
    }
    log.info("ingest", "linked file not downloaded; kept as a link", { mulchId, url, error: got.error });
  }
  const node = await addNode(mulchId, "link", at, { url, title: host, text: "Reading…", ...extra });
  void (async () => {
    const page = await readLink(url);
    if (!page) {
      log.warn("ingest", "page unreadable", { mulchId, url });
      failed(mulchId, node.id, "The page could not be read.");
      await emit(mulchId, { type: "notice", level: "info", message: `Could not read ${host}. The link is kept.` });
      return;
    }
    const assetId = await saveAsset(mulchId, Buffer.from(page.text), "page.md");
    await applyToMulch(mulchId, [{ op: "updateNode", id: node.id, patch: { title: page.title || host, text: page.summary, assetId } }], "ingest");
    submitIngest(mulchId, node.id, `Reading ${host}`, `Page: ${page.title}\nURL: ${url}\n\n${page.text}`);
  })().catch((error) => {
    log.error("ingest", "link could not be read", { mulchId, url, error });
    failed(mulchId, node.id, "The page could not be read.");
  });
  return node;
}

/**
 * A YouTube or Vimeo link: a card that plays it in place, with its title and
 * poster (from the site's oEmbed). With a Gemini key, YouTube videos are
 * watched for a summary and transcript, which are read like a document.
 */
async function addVideoLink(mulchId: string, url: string, host: string, at: { x: number; y: number }, extra: Partial<MulchNode>): Promise<MulchNode> {
  const video = videoEmbed(url)!;
  const node = await addNode(mulchId, "link", at, { url, title: host, text: "", ...extra });
  void (async () => {
    const oembed = video.provider === "youtube" ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}` : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
    const info = (await fetch(oembed, { signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined)) as { title?: string; author_name?: string; thumbnail_url?: string } | undefined;
    const posterUrl = video.poster ?? info?.thumbnail_url;
    const poster = posterUrl ? await fetchImage(posterUrl) : undefined;
    const posterId = poster && !("error" in poster) ? await saveAsset(mulchId, poster.bytes, `poster${poster.extension}`) : undefined;
    const title = info?.title ?? host;
    await applyToMulch(mulchId, [{ op: "updateNode", id: node.id, patch: { title, text: info?.author_name ?? "", ...(posterId ? { poster: posterId } : {}) } }], "ingest");
    if (video.provider !== "youtube" || !geminiAvailable()) return;
    await applyToMulch(mulchId, [{ op: "updateNode", id: node.id, patch: { text: `${info?.author_name ? `${info.author_name}. ` : ""}Watching…` } }], "ingest");
    const watched = await watchVideo(url).catch((error) => {
      log.warn("ingest", "video could not be watched", { mulchId, url, error });
      return undefined;
    });
    if (!watched) return applyToMulch(mulchId, [{ op: "updateNode", id: node.id, patch: { text: info?.author_name ?? "" } }], "ingest");
    const assetId = await saveAsset(mulchId, Buffer.from(watched), "video.md");
    const summary = /## Summary\s+([\s\S]*?)(\n## |$)/.exec(watched)?.[1]?.trim();
    await applyToMulch(mulchId, [{ op: "updateNode", id: node.id, patch: { text: excerpt(summary ?? watched), assetId } }], "ingest");
    submitIngest(mulchId, node.id, `Watching ${title}`, `Video: ${title}${info?.author_name ? ` by ${info.author_name}` : ""}\nURL: ${url}\n\n${watched}`);
  })().catch((error) => log.error("ingest", "video link failed", { mulchId, url, error }));
  return node;
}

/** Pasted text: a short one becomes a note; a long one a document that gets read. */
export async function addPastedText(mulchId: string, text: string, at: { x: number; y: number }): Promise<MulchNode> {
  if (text.length <= 280) return addNode(mulchId, "note", at, { text, userTouched: true });
  const assetId = await saveAsset(mulchId, Buffer.from(text), "pasted.md");
  const node = await addNode(mulchId, "doc", at, { assetId, fileName: "Pasted text", title: "Pasted text", text: excerpt(text) });
  submitIngest(mulchId, node.id, "Reading pasted text", text);
  return node;
}
