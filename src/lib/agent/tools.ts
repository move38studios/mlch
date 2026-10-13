/**
 * The mulch tools the agent calls. Server-only.
 *
 * Every call that changes the canvas is applied straight to the live mulch
 * as one batch (one undo step in the window), with origin `agent:<jobId>`.
 * The model never gives coordinates: it names what a new item belongs near,
 * and place.ts finds the space. It cannot move, rewrite or remove anything
 * the user made or touched unless the job allows it (an explicit command).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { newClientId } from "@/lib/mulch/ids";
import { arrangeGroups, boundsOf, placeNear } from "@/lib/mulch/place";
import { artifactHeight, estimateHeight, NODE_WIDTH, rectOf, type Rect } from "@/lib/mulch/sizes";
import { applyToMulch, atomicWriteFile, emit, getMulch, listMulches, mulchDir } from "@/lib/mulch/store";
import { NODE_KINDS, type Mulch, type MulchNode, type MulchOp, type NodeKind, type NodeRef } from "@/lib/mulch/types";
import { assetPath, isHttpUrl, isImage, readLink, saveAsset } from "@/lib/ingest/ingest";
import { fetchImage } from "@/lib/ingest/fetchImage";
import { adoptArtifact, ARTIFACT_EXTENSIONS, ARTIFACT_PATH, artifactFile, saveArtifact } from "@/lib/artifacts/artifacts";
import { desktopRequest } from "@/lib/desktop/server";
import { modelSchema, searchModels } from "@/lib/media/fal";
import { startGeneration, waitFor } from "@/lib/media/generations";
import { viewForModel } from "@/lib/media/inspect";
import { checkBudget, estimateCost } from "@/lib/media/spend";
import { readAround, search, sliceAround, type SearchHit } from "@/lib/search";
import { copyItem, resolveRef } from "@/lib/links/links";
import { addNote, autoSources, getSource, readSourceText, syncSources } from "@/lib/sources/sources";
import { exaSearch } from "@/lib/search/exa";
import { buildPptx, slideSchema, type Slide } from "@/lib/artifacts/pptx";
import { hiddenEntry, imageForModel, resolveReadable } from "./files";
import type { AgentToolDefinition, AgentToolResult, AgentToolRuntime } from "./types";

export type ToolName =
  | "get_mulch"
  | "add_nodes"
  | "connect"
  | "update_node"
  | "remove_nodes"
  | "arrange"
  | "write_doc"
  | "say"
  | "tell"
  | "add_image"
  | "hand_off"
  | "set_title"
  | "list_files"
  | "find_files"
  | "read_file"
  | "view_image"
  | "caption_image"
  | "write_artifact"
  | "make_pptx"
  | "make"
  | "present_file"
  | "preview_artifact"
  | "media_search"
  | "media_schema"
  | "media_generate"
  | "media_wait"
  | "media_view"
  | "search_mulch"
  | "search_all_mulches"
  | "read_source"
  | "focus"
  | "view"
  | "bring_in"
  | "link_to"
  | "save_note"
  | "exa_search"
  | "research"
  | "read_page";

export interface ToolContext {
  mulchId: string;
  jobId: string;
  tools: ToolName[];
  /** An explicit command may change what the user made. */
  allowUserEdits?: boolean;
  /** Folder the file tools may read: a picked folder, or the home folder for instructions. */
  readRoot?: string;
  /** For hand_off: queue a command job with this instruction. */
  onHandOff?: (instruction: string) => void;
  /** For make: queue a making job with this brief. */
  onMake?: (brief: string, options: { title?: string; near?: string[] }) => void;
  /** For research: queue a research job with this brief. */
  onResearch?: (brief: string, options: { title?: string; near?: string[] }) => void;
  /** Long jobs: the place held for this job's result, given up on first use. */
  takeHeld?: () => { x: number; y: number } | undefined;
  /** What the job is doing now, for the person. */
  onActivity?: (text: string) => void;
  /** A message for the person (`tell`), kept with the job until they close it. */
  onMessage?: (text: string) => void;
  /** Ids of nodes this job added, in order. */
  added: string[];
  /** The person's request this job serves (for review turns after generations). */
  brief?: string;
  /** The vendor session of this turn, filled in as the turn starts. */
  session?: { id?: string };
  /** Review round when this job is itself a review (0 otherwise). */
  reviewRound?: number;
  /** Origin stamped on what this job adds; default `agent:<jobId>`. The fast lane uses `speech:<jobId>`. */
  origin?: string;
  /** Linked folders this job may search: all (the person asked), or only those set to be used without asking (default). */
  sources?: "all" | "auto";
}

/* ── describing the canvas to the model ────────────────────────── */

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function nodeLine(node: MulchNode, textLimit: number): string {
  const r = rectOf(node);
  const flags = [
    node.userTouched || node.origin === "user" ? "user" : node.origin.startsWith("speech:") ? "said" : undefined,
    node.groupId ? `group=${node.groupId}` : undefined,
  ].filter(Boolean);
  const head = `${node.id} [${node.kind}] @${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  if (node.ref) return `${head}: link to ${"mulchId" in node.ref ? `item ${node.ref.itemId} in mulch ${node.ref.mulchId}` : `${node.ref.path} in source ${node.ref.sourceId}`}${node.title ? ` "${oneLine(node.title)}"` : ""}`;
  const body = [node.title ? `"${oneLine(node.title)}"` : undefined, node.url, clip(oneLine(node.text), textLimit)].filter(Boolean).join(" — ");
  return `${head}: ${body}`;
}

/** Compact text form of the canvas for prompts and get_mulch. */
export function describeMulch(mulch: Mulch, options: { textLimit?: number; maxNodes?: number } = {}): string {
  const textLimit = options.textLimit ?? 220;
  const nodes = Object.values(mulch.nodes).sort((a, b) => a.createdAt - b.createdAt);
  const shown = options.maxNodes && nodes.length > options.maxNodes ? nodes.slice(-options.maxNodes) : nodes;
  const lines = [`Canvas "${mulch.title}" — ${nodes.length} items, ${Object.keys(mulch.edges).length} connections.`];
  if (shown.length < nodes.length) lines.push(`(Showing the newest ${shown.length}; call get_mulch for all.)`);
  const bounds = boundsOf(nodes.map(rectOf));
  if (bounds) lines.push(`Bounds: ${Math.round(bounds.x)},${Math.round(bounds.y)} to ${Math.round(bounds.x + bounds.w)},${Math.round(bounds.y + bounds.h)}`);
  if (!nodes.length) lines.push("(empty)");
  lines.push("", "Items:");
  for (const node of shown) lines.push(nodeLine(node, textLimit));
  const edges = Object.values(mulch.edges);
  if (edges.length) {
    lines.push("", "Connections:");
    for (const edge of edges) lines.push(`${edge.source} -> ${edge.target}${edge.label ? ` (${edge.label})` : ""}`);
  }
  const groups = Object.values(mulch.groups);
  if (groups.length) {
    lines.push("", "Groups:");
    for (const group of groups) {
      const members = nodes.filter((node) => node.groupId === group.id).map((node) => node.id);
      lines.push(`${group.id} "${group.title}": ${members.join(", ") || "(empty)"}`);
    }
  }
  return lines.join("\n");
}

/* ── definitions ───────────────────────────────────────────────── */

const AI_KINDS = NODE_KINDS.filter((kind) => !["doc", "image", "note", "artifact", "writeup", "media", "ref"].includes(kind)) as [NodeKind, ...NodeKind[]];

const newNodeShape = z.object({
  ref: z.string().max(40).optional().describe("Your temporary name for this item, to connect it to others in the same call."),
  kind: z.enum(AI_KINDS).describe("idea | question | search | definition | example | link"),
  title: z.string().max(200).optional().describe("Short heading. Required for search, definition and link."),
  text: z.string().max(6000).describe("The content. Markdown allowed except for idea and question."),
  url: z.string().max(2000).optional().describe("Source URL for search and link items."),
  near: z.array(z.string()).max(6).optional().describe("Ids or refs of items this belongs next to. It is placed in free space beside them."),
  group: z.string().optional().describe("Id of an existing group to put it in."),
});

const edgeShape = z.object({
  from: z.string().describe("Item id or ref"),
  to: z.string().describe("Item id or ref"),
  label: z.string().max(40).optional().describe("How they relate, 1-4 words. Omit when obvious."),
});

/** Making and research jobs: the brief, a short name the person sees, and what the result belongs near. */
const LONG_JOB_SHAPE = {
  brief: z.string().min(10).max(8000),
  title: z.string().max(60).optional().describe('2-6 words the person sees while it runs, in sentence case ("Deck on forest cities").'),
  near: z.array(z.string()).max(6).optional().describe("Ids of the items the result belongs near."),
};

const DEFINITIONS: Record<ToolName, AgentToolDefinition> = {
  get_mulch: {
    name: "get_mulch",
    title: "Read mulch",
    description: "The whole mulch: every item with id, kind, position, size, who made it, and text; connections; groups.",
    inputShape: {},
    readOnly: true,
  },
  add_nodes: {
    name: "add_nodes",
    title: "Add items",
    description:
      "Add items to the canvas and optionally connect them, in one call. Never give coordinates: name what each item belongs `near` " +
      "(existing ids or refs from this call) and it is placed in free space there. Items without `near` go beside the most recent items.",
    inputShape: {
      nodes: z.array(newNodeShape).min(1).max(20),
      edges: z.array(edgeShape).max(40).optional().describe("Connections to make after adding, by id or ref."),
    },
    readOnly: false,
  },
  connect: {
    name: "connect",
    title: "Connect items",
    description: "Connect existing items. Use sparingly: only real relations worth seeing.",
    inputShape: { edges: z.array(edgeShape).min(1).max(40) },
    readOnly: false,
  },
  update_node: {
    name: "update_node",
    title: "Edit item",
    description: "Change an item's title or text. Items the user made or touched can only be changed when the user asked for it.",
    inputShape: {
      id: z.string(),
      title: z.string().max(200).optional(),
      text: z.string().max(20000).optional(),
    },
    readOnly: false,
  },
  remove_nodes: {
    name: "remove_nodes",
    title: "Remove",
    description:
      "Remove things from the canvas: items of any kind (cards, documents, made files, images, links) with their connections, and groups (the labelled boxes, ids g-…). " +
      "Removing a group removes its box; its items stay unless listed too. Groups left empty by a removal go as well. " +
      "`all: true` clears the whole canvas (every item, connection and group), only when the person asked to erase everything. " +
      "Items and groups the person made or touched can only be removed when the person asked for it. Files stay in the canvas's folder.",
    inputShape: {
      ids: z.array(z.string()).max(200).optional().describe("Ids of items and groups to remove."),
      all: z.boolean().optional().describe("Clear everything on the canvas."),
    },
    readOnly: false,
  },
  arrange: {
    name: "arrange",
    title: "Arrange",
    description:
      "Lay items out in labelled groups. You choose the groups and their order; the layout is computed. " +
      "Listed items move into a grid of group boxes; items not listed stay where they are. Existing groups whose items all move are replaced.",
    inputShape: {
      groups: z
        .array(z.object({ title: z.string().max(80), ids: z.array(z.string()).min(1).max(40) }))
        .min(1)
        .max(12),
    },
    readOnly: false,
  },
  write_doc: {
    name: "write_doc",
    title: "Write document",
    description: "Write a markdown document (summary, write-up, outline) and put it on the canvas as a write-up card, saved as a file in the canvas's docs folder.",
    inputShape: {
      title: z.string().max(120),
      markdown: z.string().max(100000),
      near: z.array(z.string()).max(6).optional(),
    },
    readOnly: false,
  },
  say: {
    name: "say",
    title: "Status",
    description: "Show the user one short status line (under 15 words). Not for content; content goes on the canvas.",
    inputShape: { text: z.string().max(200) },
    readOnly: true,
  },
  tell: {
    name: "tell",
    title: "Message",
    description:
      "A message the person reads in a bubble until they close it: the answer when they asked a question, why something they asked for could not be done (and what would work), " +
      "or one question back when the instruction is unclear. A few short paragraphs at most; markdown allowed. Never to report what you did (the canvas shows that; use say). " +
      "Content worth keeping goes on the canvas instead. At most once per turn.",
    inputShape: { text: z.string().min(1).max(3000) },
    readOnly: true,
  },
  hand_off: {
    name: "hand_off",
    title: "Hand off",
    description:
      "The user's words are an instruction to you (organize, clean up, summarize, write up, look something up, remove…), not content. " +
      "Pass the instruction on, in the user's words; it runs as a separate job with more tools.",
    inputShape: { instruction: z.string().max(2000) },
    readOnly: true,
  },
  set_title: {
    name: "set_title",
    title: "Name mulch",
    description:
      "Name the canvas: 2-5 plain words for what it is about, in sentence case (capital only on the first word and on names), " +
      "no quotes or full stop. Example: \"Cities learning from forests\", not \"Cities Learning From Forests\".",
    inputShape: { title: z.string().min(1).max(60) },
    readOnly: false,
  },
  write_artifact: {
    name: "write_artifact",
    title: "Make file",
    description:
      "Save a file you wrote (an HTML page or slide deck, SVG, markdown, CSV, JSON, text) in the canvas's artifacts folder and put a card for it on the canvas. " +
      "HTML opens full-window inside mlch and must be self-contained: inline CSS and JS; scripts and styles only from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com; fonts from Google Fonts; " +
      "images only as data: URIs. It cannot fetch anything at runtime and cannot open other pages. " +
      "To use an image or font file from this Mac (the person's logo, their fonts), write {{file:~/path/to/logo.svg}} where its URL goes (an img src, a CSS url()); it is replaced with the file's contents as a data: URI.",
    inputShape: {
      title: z.string().max(120),
      extension: z.enum(["html", "svg", "md", "csv", "json", "txt"]),
      content: z.string().max(600_000),
      description: z.string().max(400).describe("One or two sentences for the card."),
      near: z.array(z.string()).max(6).optional(),
      replace: z.string().max(200).optional().describe("Path of an artifact you made earlier (e.g. artifacts/deck.html) to overwrite with this content instead of making a new one."),
    },
    readOnly: false,
  },
  preview_artifact: {
    name: "preview_artifact",
    title: "Look at page",
    description:
      "Render an HTML or SVG artifact as the person will see it (1280x720) and get screenshots back, plus any script errors. " +
      "`slides` > 1 presses the right arrow between screenshots. Use it after writing HTML, fix what is wrong with write_artifact `replace`, and look again.",
    inputShape: { path: z.string().max(200), slides: z.number().int().min(1).max(8).optional() },
    readOnly: true,
  },
  make_pptx: {
    name: "make_pptx",
    title: "Make PowerPoint",
    description: "Build a PowerPoint (.pptx) deck from a list of slides, save it in the canvas's artifacts folder and put a card for it on the canvas. Layout and styling are done for you.",
    inputShape: {
      title: z.string().max(120),
      slides: z.array(slideSchema).min(1).max(60),
      accent: z.string().max(7).optional().describe("Accent colour as hex, e.g. D2491F."),
      description: z.string().max(400).describe("One or two sentences for the card."),
      near: z.array(z.string()).max(6).optional(),
    },
    readOnly: false,
  },
  search_mulch: {
    name: "search_mulch",
    title: "Search mulch",
    description:
      "Search everything on this canvas by meaning and by words: items, the full text of documents and links (with page numbers), write-ups, artifacts, captions, media prompts, and what the person said. " +
      "Use it for \"find that image where…\", \"the quote about…\", and before answering about anything not in the canvas summary. Returns passages with item ids.",
    inputShape: {
      query: z.string().min(1).max(500),
      kinds: z.array(z.string()).max(10).optional().describe("Only these item kinds (idea, doc, link, image, media, writeup, artifact, transcript, …)."),
      limit: z.number().int().min(1).max(30).optional(),
    },
    readOnly: true,
  },
  search_all_mulches: {
    name: "search_all_mulches",
    title: "Search all canvases",
    description:
      "Search everything the person knows: all their canvases and their linked folders (notes, wiki, an Obsidian vault, company documents). Results name the canvas or folder. " +
      "Link a closely related result here with link_to; read more with read_source.",
    inputShape: { query: z.string().min(1).max(500), limit: z.number().int().min(1).max(30).optional() },
    readOnly: true,
  },
  link_to: {
    name: "link_to",
    title: "Link",
    description:
      "Put a link card on this canvas pointing at an item in another canvas (mulch_id + item_id) or a file in a linked folder (source_id + path), next to and connected to the item it relates to. " +
      "It copies nothing: the card shows the target live and opens it. Give `why`: the connection in 1-6 words (it labels the connection). Only for a real, specific connection, not a shared topic word.",
    inputShape: {
      mulch_id: z.string().optional(),
      item_id: z.string().optional(),
      source_id: z.string().optional(),
      path: z.string().max(1000).optional(),
      near: z.string().describe("Id of the item on this canvas it relates to."),
      why: z.string().min(2).max(60).describe('How they connect, 1-6 words ("same argument, 2024", "counterexample", "earlier decision").'),
    },
    readOnly: false,
  },
  save_note: {
    name: "save_note",
    title: "Save note",
    description: "Add a new markdown note to one of the person's linked folders (only where they allowed it; never changes existing notes). Use when they ask to save something to their notes, wiki or vault.",
    inputShape: { source_id: z.string(), name: z.string().min(1).max(120).describe("File name without extension."), markdown: z.string().min(1).max(200_000) },
    readOnly: false,
  },
  read_source: {
    name: "read_source",
    title: "Read source",
    description:
      "Read the full text of an item around a page or character offset from a search hit (documents, links, write-ups, artifacts). " +
      "For another canvas give its mulch_id; for a file in a linked folder give source_id and path (id is then ignored).",
    inputShape: {
      id: z.string().optional(),
      mulch_id: z.string().optional(),
      source_id: z.string().optional(),
      path: z.string().max(1000).optional(),
      page: z.number().int().min(1).optional(),
      offset: z.number().int().min(0).optional(),
    },
    readOnly: true,
  },
  focus: {
    name: "focus",
    title: "Show",
    description:
      "Show items to the person: the canvas moves to them and highlights them. Use it for \"show me …\" or \"zoom in on …\": pass the ids of the items (or a group id for a whole group). With one document item and a page or quote, its text opens at that place.",
    inputShape: {
      ids: z.array(z.string()).min(1).max(40),
      page: z.number().int().min(1).optional(),
      quote: z.string().max(400).optional().describe("Text to highlight in the opened document."),
    },
    readOnly: true,
  },
  view: {
    name: "view",
    title: "Move view",
    description:
      "Move the person's view of the canvas: \"fit\" shows everything, \"in\" and \"out\" zoom one step. To show particular items or a part of the canvas, use focus instead.",
    inputShape: { action: z.enum(["fit", "in", "out"]) },
    readOnly: true,
  },
  exa_search: {
    name: "exa_search",
    title: "Search the web (Exa)",
    description:
      "Meaning-based web search with page text. Best for: companies and competitors (category \"company\", describe the product rather than naming one), research papers (\"research paper\"), " +
      "recent news (\"news\" with start_published_date). Use the built-in web search for general questions.",
    inputShape: {
      query: z.string().min(2).max(500),
      category: z.enum(["company", "research paper", "news", "pdf", "github", "personal site", "financial report"]).optional(),
      start_published_date: z.string().max(10).optional().describe("YYYY-MM-DD"),
      num_results: z.number().int().min(1).max(20).optional(),
    },
    readOnly: true,
  },
  research: {
    name: "research",
    title: "Research",
    description:
      "Start a research job for anything that needs many searches and reading: competitor or market scans, prior art, literature reviews, landscape overviews. " +
      "It runs for several minutes and puts sources, a comparison table and a write-up on the canvas. Give a complete brief: the question, what to compare, what matters.",
    inputShape: LONG_JOB_SHAPE,
    readOnly: true,
  },
  read_page: {
    name: "read_page",
    title: "Read page",
    description: "The full text of a web page (more reliable than the built-in fetch for long or script-heavy pages).",
    inputShape: { url: z.string().url().max(2000) },
    readOnly: true,
  },
  add_image: {
    name: "add_image",
    title: "Add picture",
    description:
      "Put an existing picture on the canvas: from the web (`url`: the address of the image file itself, https) or from this Mac (`path`, read-only). " +
      "Use it for diagrams, figures, photos and covers that sources show. Say what it is in `caption` and, for the web, where it comes from in `source_url` (the page). " +
      "For pictures that do not exist yet, use media_generate.",
    inputShape: {
      url: z.string().max(2000).optional(),
      path: z.string().max(1000).optional(),
      caption: z.string().min(1).max(600),
      source_url: z.string().max(2000).optional().describe("The page the picture is on, for credit."),
      near: z.array(z.string()).max(6).optional(),
    },
    readOnly: false,
  },
  bring_in: {
    name: "bring_in",
    title: "Bring in",
    description: "Copy an item from another mulch into this one (with its file), noting where it came from.",
    inputShape: { mulch_id: z.string(), item_id: z.string(), near: z.array(z.string()).max(6).optional() },
    readOnly: false,
  },
  media_search: {
    name: "media_search",
    title: "Find models",
    description:
      "Search fal's catalogue of generative models (image, video, speech, music, 3D, editing, upscaling…). Returns endpoint ids, what they do, how recent, and price. " +
      "Filter by category (e.g. text-to-image, image-to-image, text-to-video, image-to-video, video-to-video, text-to-speech, text-to-audio, audio-to-audio, image-to-3d, text-to-3d) and/or a query. Prefer recent, well-known models.",
    inputShape: { query: z.string().max(200).optional(), category: z.string().max(60).optional() },
    readOnly: true,
  },
  media_schema: {
    name: "media_schema",
    title: "Model inputs",
    description: "The input and output schema and price of a fal model (endpoint id from media_search). Read it before media_generate.",
    inputShape: { endpoint: z.string().max(200) },
    readOnly: true,
  },
  media_generate: {
    name: "media_generate",
    title: "Generate",
    description:
      "Start a generation on fal. Puts a card on the canvas right away that shows progress; returns the generation id without waiting. " +
      "To use mulch items as inputs (an image to animate or edit, audio, video), put \"item:<item id>\" where the schema wants a URL. " +
      "Costs money: give estimated_cost_usd from the price. Use media_wait to see results within this turn, or review: true for long jobs (video, 3D) to be called back when done.",
    inputShape: {
      endpoint: z.string().max(200),
      input: z.record(z.string(), z.unknown()).describe("Input matching the model's schema."),
      title: z.string().max(80).describe("Short card title."),
      prompt: z.string().max(2000).describe("What this is, in plain words, for the card."),
      estimated_cost_usd: z.number().min(0).max(100).optional(),
      near: z.array(z.string()).max(6).optional(),
      review: z.boolean().optional().describe("Call you back to check the result when it finishes (use for jobs over ~2 minutes)."),
    },
    readOnly: false,
  },
  media_wait: {
    name: "media_wait",
    title: "Wait for media",
    description:
      "Wait for generations to finish (up to max_seconds, at most 300) and see the results: images as images, video as sampled frames, speech transcribed, 3D rendered from four sides. " +
      "Ids are generation ids or media item ids.",
    inputShape: { ids: z.array(z.string()).min(1).max(8), max_seconds: z.number().int().min(5).max(300).optional() },
    readOnly: true,
  },
  media_view: {
    name: "media_view",
    title: "Look at media",
    description: "See a media or image item on the canvas (images as images, video as frames, speech transcribed, 3D from four sides).",
    inputShape: { id: z.string() },
    readOnly: true,
  },
  make: {
    name: "make",
    title: "Make with tools",
    description:
      "Start a making job: Claude Code or Codex with its own shell and file tools in a sandbox (Python, python-pptx, node, and so on), for files that need real tools: " +
      "PowerPoint decks, Word or PDF documents, spreadsheets, charts. It saves results in the canvas's artifacts folder and they appear on the canvas. " +
      "Give a complete brief: what to make, for whom, the format, and which mulch items it should draw on.",
    inputShape: LONG_JOB_SHAPE,
    readOnly: true,
  },
  present_file: {
    name: "present_file",
    title: "Put file on mulch",
    description: "Put a card on the canvas for a file you saved in the artifacts folder (path relative to it, e.g. deck.pptx).",
    inputShape: {
      path: z.string().max(300),
      title: z.string().max(120),
      description: z.string().max(400),
      near: z.array(z.string()).max(6).optional(),
    },
    readOnly: false,
  },
  list_files: {
    name: "list_files",
    title: "List files",
    description: "List files and folders under a path (relative to the readable root, or absolute inside it; '' for the root). Read-only.",
    inputShape: { path: z.string().max(1000) },
    readOnly: true,
  },
  find_files: {
    name: "find_files",
    title: "Find files",
    description: "Find files or folders whose name contains `name` (case-insensitive), searching up to 6 levels under `under`. Read-only.",
    inputShape: { name: z.string().min(1).max(200), under: z.string().max(1000).optional() },
    readOnly: true,
  },
  read_file: {
    name: "read_file",
    title: "Read file",
    description:
      "Read a file (relative to the readable root, or absolute inside it). Text, PDF and Word files come back as text; images come back as images. " +
      "Long text is cut; pass `offset` (characters) to read further. Read-only.",
    inputShape: { path: z.string().max(1000), offset: z.number().int().min(0).optional() },
    readOnly: true,
  },
  view_image: {
    name: "view_image",
    title: "Look at image",
    description: "See an image item on the canvas (by id).",
    inputShape: { id: z.string() },
    readOnly: true,
  },
  caption_image: {
    name: "caption_image",
    title: "Caption image",
    description: "Set an image item's title and caption (what it shows and why it matters, 1-3 sentences). Only for images without a caption, unless the person asked.",
    inputShape: { id: z.string(), title: z.string().max(120).optional(), text: z.string().max(1000) },
    readOnly: false,
  },
};

/* ── execution ─────────────────────────────────────────────────── */

const ok = (text: string, summary: string, ops: MulchOp[] = []): AgentToolResult => ({ ok: true, text, summary, ops });
const fail = (text: string): AgentToolResult => ({ ok: false, text, summary: "Failed", ops: [] });

/** Made, said or touched by the person. */
function isUserOwned(node: MulchNode): boolean {
  return node.origin === "user" || node.origin.startsWith("speech:") || !!node.userTouched;
}

const EMBED_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};

/** {{file:~/path}} in a made file becomes that image or font from this Mac, as a data: URI (read-only, private places refused). */
export async function embedFiles(content: string, readRoot: string | undefined): Promise<{ content: string; problems: string[] }> {
  const problems: string[] = [];
  const found = [...new Set([...content.matchAll(/\{\{file:([^}]+)\}\}/g)].map((m) => m[1].trim()))];
  if (!found.length) return { content, problems };
  const uris = new Map<string, string>();
  for (const name of found) {
    const type = EMBED_TYPES[path.extname(name).toLowerCase()];
    const file = readRoot ? resolveReadable(readRoot, name) : undefined;
    if (!type) problems.push(`${name}: only images and fonts can be embedded.`);
    else if (!file) problems.push(`${name}: outside what you may read.`);
    else {
      const bytes = await fs.readFile(file).catch(() => undefined);
      if (!bytes) problems.push(`${name}: not found.`);
      else if (bytes.length > 5 * 1024 * 1024) problems.push(`${name}: over 5 MB.`);
      else uris.set(name, `data:${type};base64,${bytes.toString("base64")}`);
    }
  }
  return { content: content.replace(/\{\{file:([^}]+)\}\}/g, (all, name: string) => uris.get(name.trim()) ?? all), problems };
}

/** Markdown without a first-line heading that only repeats the title. */
export function withoutTitleHeading(markdown: string, title: string): string {
  const match = /^\s*#{1,2}\s+(.+?)\s*(\n|$)/.exec(markdown);
  const same = (a: string) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return match && same(match[1]) === same(title) ? markdown.slice(match[0].length).replace(/^\s+/, "") : markdown;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "doc"
  );
}

/** Review turns after a generation, per request. */
export const MAX_REVIEW_ROUNDS = 3;

function hitLine(hit: SearchHit): string {
  return `item ${hit.nodeId} [${hit.kind}]${hit.title ? ` "${hit.title}"` : ""}${hit.page ? ` p.${hit.page}` : ""}${hit.offset !== undefined && hit.kind !== "transcript" ? ` @${hit.offset}` : ""}: ${hit.snippet}`;
}

const READ_LIMIT = 30_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".venv"]);

export function createMulchTools(ctx: ToolContext): AgentToolRuntime {
  const origin = ctx.origin ?? `agent:${ctx.jobId}`;
  const definitions = ctx.tools.map((name) => DEFINITIONS[name]);
  const schemas = new Map(definitions.map((definition) => [definition.name, z.object(definition.inputShape)]));

  async function commit(ops: MulchOp[]) {
    if (ops.length) await applyToMulch(ctx.mulchId, ops, origin);
  }

  function resolver(mulch: Mulch, refs: Map<string, string>) {
    return (key: string) => refs.get(key) ?? (mulch.nodes[key] ? key : undefined);
  }

  function edgeOps(mulch: Mulch, edges: z.infer<typeof edgeShape>[], resolve: (key: string) => string | undefined, problems: string[]) {
    const ops: MulchOp[] = [];
    const existing = new Set(Object.values(mulch.edges).map((edge) => `${edge.source}>${edge.target}`));
    for (const edge of edges) {
      const source = resolve(edge.from);
      const target = resolve(edge.to);
      if (!source || !target) {
        problems.push(`Connection ${edge.from} -> ${edge.to}: unknown ${!source ? edge.from : edge.to}.`);
        continue;
      }
      if (source === target || existing.has(`${source}>${target}`) || existing.has(`${target}>${source}`)) continue;
      existing.add(`${source}>${target}`);
      ops.push({ op: "addEdge", edge: { id: newClientId("e"), source, target, ...(edge.label ? { label: edge.label } : {}), origin, createdAt: Date.now() } });
    }
    return ops;
  }

  /** Near the given items; a long job's first result takes the place held for it. */
  function placeResult(mulch: Mulch, size: { w: number; h: number }, near: string[] | undefined, seed: string) {
    const held = ctx.takeHeld?.();
    if (held) return placeNear(mulch, size, { fallback: { x: held.x + size.w / 2, y: held.y + size.h / 2 }, seed });
    return placeNear(mulch, size, { anchorIds: (near ?? []).filter((key) => mulch.nodes[key]), seed });
  }

  async function addArtifactCard(title: string, description: string, docPath: string, near?: string[]): Promise<string> {
    const mulch = await getMulch(ctx.mulchId);
    const id = newClientId("n");
    const position = placeResult(mulch, { w: NODE_WIDTH.artifact, h: artifactHeight(docPath) }, near, id);
    await commit([
      { op: "addNode", node: { id, kind: "artifact", x: position.x, y: position.y, title, text: description, docPath, fileName: path.basename(docPath), origin, createdAt: Date.now() } },
    ]);
    ctx.added.push(id);
    return id;
  }

  async function viewNode(id: string): Promise<{ text: string; images: NonNullable<AgentToolResult["images"]> }> {
    const node = (await getMulch(ctx.mulchId)).nodes[id];
    if (!node?.assetId) return { text: `${id} has no media file${node?.gen ? ` (generation ${node.gen.status})` : ""}.`, images: [] };
    return viewForModel(assetPath(ctx.mulchId, node.assetId), node.mime, `/api/mulches/${ctx.mulchId}/model-view/${node.assetId}`);
  }

  const handlers: Record<ToolName, (args: Record<string, unknown>) => Promise<AgentToolResult>> = {
    async get_mulch() {
      return ok(describeMulch(await getMulch(ctx.mulchId)), "Read the canvas");
    },

    async add_nodes(args) {
      const input = args as { nodes: z.infer<typeof newNodeShape>[]; edges?: z.infer<typeof edgeShape>[] };
      let mulch = await getMulch(ctx.mulchId);
      const refs = new Map<string, string>();
      const problems: string[] = [];
      const ops: MulchOp[] = [];
      const pending: Rect[] = [];
      const created: MulchNode[] = [];
      for (const item of input.nodes) {
        const id = newClientId("n");
        if (item.ref) refs.set(item.ref, id);
        const resolve = resolver(mulch, refs);
        const anchors = (item.near ?? []).map(resolve).filter((x): x is string => !!x);
        const unknown = (item.near ?? []).filter((key) => !resolve(key));
        if (unknown.length) problems.push(`near: unknown ${unknown.join(", ")} (placed anyway).`);
        // Anchors added earlier in this call are not on the canvas yet; use their pending boxes.
        const view: Mulch = { ...mulch, nodes: { ...mulch.nodes, ...Object.fromEntries(created.map((n) => [n.id, n])) } };
        const w = NODE_WIDTH[item.kind];
        const h = estimateHeight(item.kind, item.text, item.title);
        const group = item.group && mulch.groups[item.group] ? item.group : undefined;
        const position = placeNear(view, { w, h }, { anchorIds: anchors, seed: id, taken: pending });
        pending.push({ ...position, w, h });
        const node: MulchNode = {
          id,
          kind: item.kind,
          x: position.x,
          y: position.y,
          text: item.text,
          ...(item.title ? { title: item.title } : {}),
          ...(item.url ? { url: item.url } : {}),
          ...(group ? { groupId: group } : {}),
          origin,
          createdAt: Date.now(),
        };
        created.push(node);
        ops.push({ op: "addNode", node });
      }
      mulch = { ...mulch, nodes: { ...mulch.nodes, ...Object.fromEntries(created.map((n) => [n.id, n])) } };
      ops.push(...edgeOps(mulch, input.edges ?? [], resolver(mulch, refs), problems));
      await commit(ops);
      ctx.added.push(...created.map((node) => node.id));
      const mapping = input.nodes.map((item, i) => `${item.ref ?? `#${i + 1}`} = ${created[i].id}`).join(", ");
      const edgeCount = ops.filter((op) => op.op === "addEdge").length;
      return ok(
        `Added ${created.length} items (${mapping})${edgeCount ? ` and ${edgeCount} connections` : ""}.${problems.length ? ` Notes: ${problems.join(" ")}` : ""}`,
        `Added ${created.length} item${created.length === 1 ? "" : "s"}`,
        ops,
      );
    },

    async connect(args) {
      const mulch = await getMulch(ctx.mulchId);
      const problems: string[] = [];
      const ops = edgeOps(mulch, (args as { edges: z.infer<typeof edgeShape>[] }).edges, resolver(mulch, new Map()), problems);
      await commit(ops);
      return ok(`Made ${ops.length} connections.${problems.length ? ` ${problems.join(" ")}` : ""}`, `Connected ${ops.length}`, ops);
    },

    async update_node(args) {
      const { id, title, text } = args as { id: string; title?: string; text?: string };
      const mulch = await getMulch(ctx.mulchId);
      const node = mulch.nodes[id];
      if (!node) return fail(`No item ${id}. Call get_mulch for current ids.`);
      if (isUserOwned(node) && !ctx.allowUserEdits) return fail(`${id} was made or edited by the user; leave it as it is unless they ask you to change it.`);
      if (title === undefined && text === undefined) return fail("Give a new title or text.");
      const ops: MulchOp[] = [{ op: "updateNode", id, patch: { ...(title !== undefined ? { title } : {}), ...(text !== undefined ? { text } : {}), updatedAt: Date.now() } }];
      await commit(ops);
      return ok(`Updated ${id}.`, "Edited an item", ops);
    },

    async remove_nodes(args) {
      const { ids = [], all } = args as { ids?: string[]; all?: boolean };
      if (!ids.length && !all) return fail("Give the ids of the items or groups to remove, or all: true to clear the canvas.");
      const mulch = await getMulch(ctx.mulchId);
      const owned = (thing: { origin: string; userTouched?: boolean }) => isUserOwned(thing as MulchNode) && !ctx.allowUserEdits;
      const wanted = all ? [...Object.keys(mulch.nodes), ...Object.keys(mulch.groups)] : ids;
      const refused: string[] = [];
      const missing: string[] = [];
      const nodeIds = new Set<string>();
      const groupIds = new Set<string>();
      for (const id of wanted) {
        const thing = mulch.nodes[id] ?? mulch.groups[id];
        if (!thing) missing.push(id);
        else if (owned(thing)) refused.push(id);
        else if (mulch.nodes[id]) nodeIds.add(id);
        else groupIds.add(id);
      }
      // A box whose items all go is not left behind empty.
      for (const group of Object.values(mulch.groups)) {
        const members = Object.values(mulch.nodes).filter((node) => node.groupId === group.id);
        if (members.length && members.every((node) => nodeIds.has(node.id))) groupIds.add(group.id);
      }
      const ops: MulchOp[] = [...[...nodeIds].map((id): MulchOp => ({ op: "removeNode", id })), ...[...groupIds].map((id): MulchOp => ({ op: "removeGroup", id }))];
      await commit(ops);
      const notes = [
        refused.length ? `Kept ${refused.join(", ")}: made or edited by the person; remove them only if they ask.` : "",
        missing.length ? `Not found: ${missing.join(", ")}. Call get_mulch for current ids.` : "",
      ].filter(Boolean);
      const done = `Removed ${nodeIds.size} item${nodeIds.size === 1 ? "" : "s"}${groupIds.size ? ` and ${groupIds.size} group${groupIds.size === 1 ? "" : "s"}` : ""}.`;
      return ok(`${done} ${notes.join(" ")}`.trim(), `Removed ${nodeIds.size + groupIds.size}`, ops);
    },

    async arrange(args) {
      const { groups } = args as { groups: Array<{ title: string; ids: string[] }> };
      const mulch = await getMulch(ctx.mulchId);
      const ids = groups.flatMap((group) => group.ids);
      const missing = ids.filter((id) => !mulch.nodes[id]);
      const userMoved = ids.filter((id) => mulch.nodes[id] && isUserOwned(mulch.nodes[id]));
      if (userMoved.length && !ctx.allowUserEdits) return fail(`The user placed ${userMoved.join(", ")}; leave them where they are unless they ask you to arrange.`);
      const { moves, boxes } = arrangeGroups(mulch, groups.map((group) => ({ title: group.title, nodeIds: group.ids })));
      if (!moves.length) return fail(`Nothing to arrange. Unknown ids: ${missing.join(", ")}. Call get_mulch for current ids.`);
      const moving = new Set(moves.map((move) => move.id));
      const ops: MulchOp[] = [];
      // Groups whose members all move are replaced by the new boxes.
      for (const group of Object.values(mulch.groups)) {
        const members = Object.values(mulch.nodes).filter((node) => node.groupId === group.id);
        if (members.every((node) => moving.has(node.id))) ops.push({ op: "removeGroup", id: group.id });
      }
      for (const box of boxes) {
        const groupId = newClientId("g");
        ops.push({ op: "addGroup", group: { id: groupId, title: box.title, x: box.x, y: box.y, w: box.w, h: box.h, origin, createdAt: Date.now() } });
        for (const nodeId of box.nodeIds) {
          const move = moves.find((m) => m.id === nodeId)!;
          ops.push({ op: "updateNode", id: nodeId, patch: { x: move.x, y: move.y, groupId } });
        }
      }
      await commit(ops);
      return ok(
        `Arranged ${moves.length} items in ${boxes.length} groups.${missing.length ? ` Unknown ids skipped: ${missing.join(", ")}.` : ""}`,
        `Arranged ${boxes.length} groups`,
        ops,
      );
    },

    async write_doc(args) {
      const { title, markdown, near } = args as { title: string; markdown: string; near?: string[] };
      const mulch = await getMulch(ctx.mulchId);
      const docs = path.join(mulchDir(ctx.mulchId), "docs");
      await fs.mkdir(docs, { recursive: true });
      let slug = slugify(title);
      const existing = new Set(await fs.readdir(docs).catch(() => [] as string[]));
      for (let i = 2; existing.has(`${slug}.md`); i++) slug = `${slugify(title)}-${i}`;
      const docPath = `docs/${slug}.md`;
      await atomicWriteFile(path.join(mulchDir(ctx.mulchId), docPath), markdown.startsWith("#") ? markdown : `# ${title}\n\n${markdown}`);
      const id = newClientId("n");
      const w = NODE_WIDTH.writeup;
      const position = placeResult(mulch, { w, h: 260 }, near, id);
      const ops: MulchOp[] = [
        // The card shows the title itself: a leading heading that repeats it is left out of the card's text.
        { op: "addNode", node: { id, kind: "writeup", x: position.x, y: position.y, title, text: withoutTitleHeading(markdown, title), docPath, origin, createdAt: Date.now() } },
      ];
      await commit(ops);
      ctx.added.push(id);
      return ok(`Wrote ${docPath} and added write-up ${id}.`, `Wrote "${title}"`, ops);
    },

    async say(args) {
      const text = (args as { text: string }).text;
      await emit(ctx.mulchId, { type: "say", text, jobId: ctx.jobId });
      ctx.onActivity?.(text);
      return ok("Shown.", "Status");
    },

    async add_image(args) {
      const { url, path: file, caption, source_url, near } = args as { url?: string; path?: string; caption: string; source_url?: string; near?: string[] };
      if (!url === !file) return fail("Give either url (an image on the web) or path (an image on this Mac).");
      let bytes: Buffer;
      let fileName: string;
      if (url) {
        const got = await fetchImage(url);
        if ("error" in got) return fail(`${got.error} Nothing was added.`);
        bytes = got.bytes;
        fileName = `${path.basename(new URL(url).pathname).replace(/\.[^.]*$/, "") || "image"}${got.extension}`;
      } else {
        const resolved = resolveReadable(ctx.readRoot ?? os.homedir(), file!);
        if (!resolved || !isImage(resolved)) return fail(`${file}: not an image you may read (png, jpg, gif, webp, svg in your home folder, private places excluded).`);
        const read = await fs.readFile(resolved).catch(() => undefined);
        if (!read) return fail(`${file}: not found.`);
        if (read.length > 15 * 1024 * 1024) return fail(`${file}: over 15 MB.`);
        bytes = read;
        fileName = path.basename(resolved);
      }
      const assetId = await saveAsset(ctx.mulchId, bytes, fileName);
      const mulch = await getMulch(ctx.mulchId);
      const id = newClientId("n");
      const position = placeResult(mulch, { w: NODE_WIDTH.image, h: 240 }, near, id);
      const source = source_url && isHttpUrl(source_url) ? source_url : url;
      const ops: MulchOp[] = [
        { op: "addNode", node: { id, kind: "image", x: position.x, y: position.y, assetId, fileName: fileName.slice(0, 200), text: caption, ...(source ? { url: source } : {}), origin, createdAt: Date.now() } },
      ];
      await commit(ops);
      ctx.added.push(id);
      return ok(`Added picture ${id}.`, "Added a picture", ops);
    },

    async tell(args) {
      const text = (args as { text: string }).text.trim();
      if (!ctx.onMessage) return fail("Messages are not available here; use say for one short line.");
      ctx.onMessage(text);
      return ok("Shown to the person until they close it.", "Message");
    },

    async hand_off(args) {
      const { instruction } = args as { instruction: string };
      if (!ctx.onHandOff) return fail("Not available here.");
      ctx.onHandOff(instruction);
      return ok("Queued as a command.", "Handed off");
    },

    async set_title(args) {
      const mulch = await getMulch(ctx.mulchId);
      // Only names an unnamed mulch; the person's own title stays.
      if (mulch.title !== "Untitled") return ok("The mulch already has a name.", "Kept name");
      const ops: MulchOp[] = [{ op: "setTitle", title: (args as { title: string }).title.trim() }];
      await commit(ops);
      return ok("Named.", "Named the canvas", ops);
    },

    async write_artifact(args) {
      const { title, extension, description, near, replace } = args as {
        title: string; extension: string; content: string; description: string; near?: string[]; replace?: string;
      };
      // Named files from anywhere the person may share (house style: their logo, fonts), private places refused.
      const embedded = await embedFiles((args as { content: string }).content, ctx.readRoot ?? os.homedir());
      if (embedded.problems.length) return fail(`${embedded.problems.join(" ")} Nothing was saved; fix the {{file:…}} paths or leave them out.`);
      const content = embedded.content;
      if (replace) {
        const mulch = await getMulch(ctx.mulchId);
        const node = Object.values(mulch.nodes).find((n) => n.kind === "artifact" && n.docPath === replace);
        if (!node || !ARTIFACT_PATH.test(replace) || !replace.endsWith(`.${extension}`)) return fail(`No artifact ${replace} with extension ${extension} on the canvas.`);
        if (isUserOwned(node) && !ctx.allowUserEdits) return fail(`${replace} belongs to the person.`);
        await atomicWriteFile(artifactFile(ctx.mulchId, replace), content);
        await commit([{ op: "updateNode", id: node.id, patch: { title, text: description, updatedAt: Date.now() } }]);
        return ok(`Replaced ${replace}.`, `Revised ${title}`);
      }
      const docPath = await saveArtifact(ctx.mulchId, title, extension, Buffer.from(content));
      const id = await addArtifactCard(title, description, docPath, near);
      return ok(`Saved ${docPath} and added card ${id}.`, `Made ${title}`, []);
    },

    async make_pptx(args) {
      const { title, slides, accent, description, near } = args as { title: string; slides: Slide[]; accent?: string; description: string; near?: string[] };
      const mulch = await getMulch(ctx.mulchId);
      const bytes = await buildPptx(title, slides, { accent: accent?.replace("#", "") }, async (imageId) => {
        const node = mulch.nodes[imageId];
        if (node?.kind !== "image" || !node.assetId) return undefined;
        return imageForModel(await fs.readFile(assetPath(ctx.mulchId, node.assetId)));
      });
      const docPath = await saveArtifact(ctx.mulchId, title, "pptx", bytes);
      const id = await addArtifactCard(title, `${description}\n\n${slides.length} slides`, docPath, near);
      return ok(`Saved ${docPath} (${slides.length} slides) and added card ${id}.`, `Made ${title}.pptx`, []);
    },

    async preview_artifact(args) {
      const { path: file, slides = 1 } = args as { path: string; slides?: number };
      const docPath = file.startsWith("artifacts/") ? file : `artifacts/${file}`;
      if (!ARTIFACT_PATH.test(docPath) || !/\.(html|svg)$/.test(docPath)) return fail("Only HTML and SVG artifacts can be previewed.");
      const result = await desktopRequest("render", { url: `/api/mulches/${ctx.mulchId}/${docPath}`, steps: slides });
      if (!result.ok) return fail(`Could not render it: ${result.error}`);
      const value = result.value as { images: string[]; errors: string[] };
      const errors = value.errors.length ? `Script errors and warnings:\n${value.errors.join("\n")}` : "No script errors.";
      return {
        ...ok(`${value.images.length} screenshot(s) of ${docPath}, in order. ${errors}`, `Looked at ${path.basename(docPath)}`),
        images: value.images.map((data) => ({ data, mimeType: "image/png" })),
      };
    },

    async research(args) {
      if (!ctx.onResearch) return fail("Not available here.");
      const { brief, title, near } = args as { brief: string; title?: string; near?: string[] };
      ctx.onResearch(brief, { title, near });
      return ok("Research job queued; it will add its results to the canvas.", "Started research");
    },

    async read_page(args) {
      const { url } = args as { url: string };
      if (!isHttpUrl(url)) return fail("Not a web link.");
      const page = await readLink(url);
      if (!page) return fail("The page could not be read (blocked, empty or not a page).");
      return ok(`${page.title}\n${url}\n\n${page.text.slice(0, 40_000)}${page.text.length > 40_000 ? "\n…(cut)" : ""}`, `Read ${new URL(url).hostname}`);
    },

    async exa_search(args) {
      const { query, category, start_published_date, num_results } = args as { query: string; category?: string; start_published_date?: string; num_results?: number };
      const results = await exaSearch({ query, category, startPublishedDate: start_published_date, numResults: num_results });
      if (!results.length) return ok("No results.", "Found nothing");
      return ok(
        results.map((r) => `${r.title}\n${r.url}${r.publishedDate ? ` (${r.publishedDate})` : ""}\n${(r.text ?? "").replace(/\s+/g, " ").slice(0, 900)}`).join("\n\n"),
        `Found ${results.length} pages`,
      );
    },

    async search_mulch(args) {
      const { query, kinds, limit } = args as { query: string; kinds?: string[]; limit?: number };
      const hits = await search(query, { mulchIds: [ctx.mulchId], kinds, limit: limit ?? 10 });
      if (!hits.length) return ok("Nothing found.", "Found nothing");
      return ok(hits.map(hitLine).join("\n\n"), `Found ${hits.length}`);
    },

    async search_all_mulches(args) {
      const { query, limit } = args as { query: string; limit?: number };
      const sources = ctx.sources === "all" ? await syncSources() : await autoSources();
      const hits = await search(query, { limit: limit ?? 12, sources: sources.map((source) => source.id) });
      if (!hits.length) return ok("Nothing found.", "Found nothing");
      const titles = new Map((await listMulches()).map((n) => [n.id, n.title]));
      const names = new Map(sources.map((source) => [source.id, source.name]));
      const line = (hit: SearchHit) =>
        hit.sourceId
          ? `folder ${hit.sourceId} "${names.get(hit.sourceId) ?? ""}" · file ${hit.path}${hit.page ? ` p.${hit.page}` : ""}${hit.offset !== undefined ? ` @${hit.offset}` : ""}: ${hit.snippet}`
          : `mulch ${hit.mulchId} "${titles.get(hit.mulchId) ?? ""}"${hit.mulchId === ctx.mulchId ? " (this one)" : ""} · ${hitLine(hit)}`;
      return ok(hits.map(line).join("\n\n"), `Found ${hits.length}`);
    },

    async read_source(args) {
      const { id, mulch_id, source_id, path: file, page, offset } = args as { id?: string; mulch_id?: string; source_id?: string; path?: string; page?: number; offset?: number };
      if (source_id || file) {
        const source = source_id ? await getSource(source_id) : undefined;
        if (!source || !file) return fail("Give source_id and path from a search_all_mulches result (folder <source_id> · file <path>).");
        if (ctx.sources !== "all" && source.mode !== "auto") return fail(`The person keeps "${source.name}" for when they ask; use it only if they do.`);
        const text = await readSourceText(source, file);
        return text ? ok(sliceAround(text, { page, offset }), "Read a note") : fail(`No readable file ${file} in "${source.name}".`);
      }
      if (!id) return fail("Give the item id (and mulch_id for another canvas), or source_id and path for a linked folder.");
      const text = await readAround(mulch_id ?? ctx.mulchId, id, { page, offset }).catch(() => undefined);
      return text ? ok(text, "Read source") : fail(`No item ${id}${mulch_id ? ` in mulch ${mulch_id}` : ""}.`);
    },

    async link_to(args) {
      const { mulch_id, item_id, source_id, path: file, near, why } = args as { mulch_id?: string; item_id?: string; source_id?: string; path?: string; near: string; why: string };
      const ref: NodeRef | undefined = mulch_id && item_id ? { mulchId: mulch_id, itemId: item_id } : source_id && file ? { sourceId: source_id, path: file } : undefined;
      if (!ref) return fail("Give mulch_id and item_id (an item in another canvas), or source_id and path (a file in a linked folder), from search_all_mulches.");
      if ("mulchId" in ref && ref.mulchId === ctx.mulchId) return fail("That item is on this canvas already; connect to it instead.");
      if ("sourceId" in ref) {
        const source = await getSource(ref.sourceId);
        if (source && ctx.sources !== "all" && source.mode !== "auto") return fail(`The person keeps "${source.name}" for when they ask; link to it only if they do.`);
      }
      const mulch = await getMulch(ctx.mulchId);
      const anchor = mulch.nodes[near];
      if (!anchor) return fail(`No item ${near} on this canvas. near is the id of the item the link relates to.`);
      const same = (node: MulchNode) => node.ref && JSON.stringify(node.ref) === JSON.stringify(ref);
      if (Object.values(mulch.nodes).some(same)) return fail("This canvas already links to that; connect to the existing link card instead.");
      const target = await resolveRef(ref);
      if (!target.exists) return fail("Nothing there: use ids and paths exactly as search_all_mulches gave them.");
      const id = newClientId("n");
      const position = placeNear(mulch, { w: NODE_WIDTH.ref, h: estimateHeight("ref", (target.text ?? "").slice(0, 160), target.title) }, { anchorIds: [near], seed: id });
      const ops: MulchOp[] = [
        { op: "addNode", node: { id, kind: "ref", x: position.x, y: position.y, ...(target.title ? { title: target.title.slice(0, 200) } : {}), text: "", ref, origin, createdAt: Date.now() } },
        { op: "addEdge", edge: { id: newClientId("e"), source: near, target: id, label: why.trim().slice(0, 60), origin, createdAt: Date.now() } },
      ];
      await commit(ops);
      ctx.added.push(id);
      return ok(`Linked as ${id} (${target.place}${target.title ? `: ${target.title}` : ""}).`, "Linked", ops);
    },

    async save_note(args) {
      const { source_id, name, markdown } = args as { source_id: string; name: string; markdown: string };
      const sources = await syncSources();
      const source = sources.find((s) => s.id === source_id);
      if (!source) return fail(`No linked folder ${source_id}. Linked folders: ${sources.map((s) => `${s.id} "${s.name}"${s.writeFolder !== undefined ? " (can add notes)" : ""}`).join(", ") || "none"}.`);
      try {
        const file = await addNote(source, name, markdown);
        return ok(`Saved as ${file} in "${source.name}".`, "Saved a note");
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },

    async focus(args) {
      const { ids, page, quote } = args as { ids: string[]; page?: number; quote?: string };
      const mulch = await getMulch(ctx.mulchId);
      const found = ids.filter((id) => mulch.nodes[id] || mulch.groups[id]);
      if (!found.length) return fail("None of those ids are items or groups on this canvas. Use ids from the canvas description.");
      await emit(ctx.mulchId, { type: "focus", ids: found, ...(page ? { page } : {}), ...(quote ? { quote } : {}) });
      return ok(`Showing ${found.length} item(s).`, "Showed items");
    },

    async view(args) {
      const { action } = args as { action: "fit" | "in" | "out" };
      await emit(ctx.mulchId, { type: "view", action });
      return ok(action === "fit" ? "Showing everything." : `Zoomed ${action}.`, "Moved view");
    },

    async bring_in(args) {
      const { mulch_id, item_id, near } = args as { mulch_id: string; item_id: string; near?: string[] };
      if (mulch_id === ctx.mulchId) return fail("That item is already on this canvas.");
      const source = await getMulch(mulch_id).catch(() => undefined);
      const node = source?.nodes[item_id];
      if (!source || !node) return fail(`No item ${item_id} in mulch ${mulch_id}.`);
      const mulch = await getMulch(ctx.mulchId);
      const anchors = (near ?? []).filter((key) => mulch.nodes[key]);
      const position = placeNear(mulch, { w: NODE_WIDTH[node.kind], h: rectOf(node).h }, { anchorIds: anchors, seed: item_id });
      const copy = await copyItem(ctx.mulchId, mulch_id, item_id, position, origin);
      if (!copy) return fail(`No item ${item_id} in mulch ${mulch_id}.`);
      const id = copy.id;
      const ops: MulchOp[] = [{ op: "addNode", node: copy }];
      await commit(ops);
      ctx.added.push(id);
      return ok(`Brought in as ${id}.`, "Brought in an item", ops);
    },

    async media_search(args) {
      const { query, category } = args as { query?: string; category?: string };
      const models = await searchModels({ query, category, limit: 40 });
      if (!models.length) return ok("No models found. Try a broader query or another category.", "Found none");
      return ok(
        models.map((m) => `${m.endpoint} — ${m.name} [${m.category}] ${m.updated}${m.price ? ` · ${m.price}` : ""}\n  ${m.description}`).join("\n"),
        `Found ${models.length} models`,
      );
    },

    async media_schema(args) {
      const schema = await modelSchema((args as { endpoint: string }).endpoint);
      return ok(
        `${schema.endpoint}${schema.price ? ` · ${schema.price}` : " · no listed price"}\n\nInput:\n${JSON.stringify(schema.input)}\n\nOutput:\n${JSON.stringify(schema.output ?? {})}`.slice(0, 30_000),
        "Read model inputs",
      );
    },

    async media_generate(args) {
      const { endpoint, input, title, prompt, estimated_cost_usd, near, review } = args as {
        endpoint: string; input: Record<string, unknown>; title: string; prompt: string; estimated_cost_usd?: number; near?: string[]; review?: boolean;
      };
      const estimate = await estimateCost(endpoint, input);
      const cost = Math.max(estimate.usd ?? 0, estimated_cost_usd ?? 0);
      if (estimate.usd === undefined && estimated_cost_usd === undefined) {
        return fail(`fal lists no price for ${endpoint} that can be estimated (${estimate.basis}). Give estimated_cost_usd from the model page or pick a model with a listed price.`);
      }
      const budget = await checkBudget(cost);
      if (!budget.ok) return fail(budget.message);
      const round = (ctx.reviewRound ?? 0) + 1;
      const record = await startGeneration({
        mulchId: ctx.mulchId,
        endpoint,
        input,
        title,
        prompt,
        near,
        origin,
        cost,
        ...(review && round <= MAX_REVIEW_ROUNDS ? { review: { brief: ctx.brief ?? prompt, round, sessionId: ctx.session?.id } } : {}),
      });
      ctx.added.push(record.nodeId);
      if (record.status === "failed") return fail(`Generation failed to start: ${record.error}`);
      return ok(
        `Started ${record.id} (item ${record.nodeId}), estimated $${cost.toFixed(3)} (${estimate.basis}).${review ? (round <= MAX_REVIEW_ROUNDS ? " You will be called back to review it when it finishes." : " No more review rounds: check it with media_wait or leave it.") : " Use media_wait to see it."}`,
        `Started ${title}`,
      );
    },

    async media_wait(args) {
      const { ids, max_seconds = 120 } = args as { ids: string[]; max_seconds?: number };
      const mulch = await getMulch(ctx.mulchId);
      const genIds: string[] = [];
      for (const id of ids) {
        const gen = mulch.nodes[id]?.gen?.id ?? id;
        genIds.push(gen);
      }
      const records = await waitFor(ctx.mulchId, genIds, max_seconds * 1000);
      const lines: string[] = [];
      const images: NonNullable<AgentToolResult["images"]> = [];
      for (const id of genIds) {
        const record = records.find((r) => r.id === id);
        if (!record) {
          lines.push(`${id}: unknown generation.`);
          continue;
        }
        if (record.status !== "done") {
          lines.push(`${record.id} (item ${record.nodeId}): ${record.status}${record.error ? ` — ${record.error}` : ""}`);
          continue;
        }
        const view = await viewNode(record.nodeId);
        lines.push(`${record.id} (item ${record.nodeId}${record.extraNodeIds.length ? ` and ${record.extraNodeIds.join(", ")}` : ""}): done. ${view.text}`);
        images.push(...view.images.slice(0, Math.max(0, 12 - images.length)));
      }
      return { ...ok(lines.join("\n"), "Checked media"), images };
    },

    async media_view(args) {
      const view = await viewNode((args as { id: string }).id);
      return { ...ok(view.text, "Looked at media"), images: view.images };
    },

    async make(args) {
      if (!ctx.onMake) return fail("Not available here.");
      const { brief, title, near } = args as { brief: string; title?: string; near?: string[] };
      ctx.onMake(brief, { title, near });
      return ok("Making job queued. Its files will appear on the canvas when done.", "Started making");
    },

    async present_file(args) {
      const { path: file, title, description, near } = args as { path: string; title: string; description: string; near?: string[] };
      const docPath = await adoptArtifact(ctx.mulchId, file.replace(/^artifacts\//, "").split("/").pop() ?? "");
      if (!docPath) return fail(`No such file in the artifacts folder, or not a supported type (${ARTIFACT_EXTENSIONS.join(", ")}). Save it there first.`);
      const mulch = await getMulch(ctx.mulchId);
      if (Object.values(mulch.nodes).some((node) => node.docPath === docPath)) return ok(`${docPath} is already on the canvas.`, "Already there");
      const id = await addArtifactCard(title, description, docPath, near);
      return ok(`Added card ${id} for ${docPath}.`, `Added ${title}`);
    },

    async list_files(args) {
      if (!ctx.readRoot) return fail("No files to read here.");
      const dir = resolveReadable(ctx.readRoot, (args as { path: string }).path || "");
      if (!dir) return fail(`That path is outside what you may read. Readable root: ${ctx.readRoot}`);
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return fail("No such folder.");
      }
      const lines: string[] = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (hiddenEntry(full)) continue;
        const rel = path.relative(ctx.readRoot, full);
        if (entry.isDirectory()) lines.push(`${rel}/`);
        else if (entry.isFile()) {
          const stat = await fs.stat(full).catch(() => undefined);
          lines.push(`${rel} (${stat ? Math.ceil(stat.size / 1024) : "?"} KB)`);
        }
        if (lines.length >= 400) {
          lines.push("(more not shown)");
          break;
        }
      }
      return ok(lines.join("\n") || "(empty)", `Listed ${path.basename(dir)}`);
    },

    async find_files(args) {
      if (!ctx.readRoot) return fail("No files to read here.");
      const { name, under = "" } = args as { name: string; under?: string };
      const start = resolveReadable(ctx.readRoot, under);
      if (!start) return fail(`That path is outside what you may read. Readable root: ${ctx.readRoot}`);
      const needle = name.toLowerCase();
      const found: string[] = [];
      let visited = 0;
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 6 || found.length >= 100 || visited > 20_000) return;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          visited++;
          if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (hiddenEntry(full)) continue;
          if (entry.name.toLowerCase().includes(needle)) found.push(`${path.relative(ctx.readRoot!, full)}${entry.isDirectory() ? "/" : ""}`);
          if (entry.isDirectory()) await walk(full, depth + 1);
          if (found.length >= 100) return;
        }
      };
      await walk(start, 0);
      return ok(found.join("\n") || "Nothing found.", `Found ${found.length}`);
    },

    async read_file(args) {
      if (!ctx.readRoot) return fail("No files to read here.");
      const { path: relative, offset = 0 } = args as { path: string; offset?: number };
      const file = resolveReadable(ctx.readRoot, relative);
      if (!file) return fail(`That file is outside what you may read, or private. Readable root: ${ctx.readRoot}`);
      if (isImage(file)) {
        try {
          return { ...ok(`Image ${path.basename(file)}.`, `Looked at ${path.basename(file)}`), images: [await imageForModel(await fs.readFile(file))] };
        } catch (error) {
          return fail(`Could not open the image: ${(error as Error).message}`);
        }
      }
      const { readText } = await import("@/lib/ingest/extract");
      const text = await readText(file).catch((error: Error) => `(could not read: ${error.message})`);
      const slice = text.slice(offset, offset + READ_LIMIT);
      const more = offset + READ_LIMIT < text.length ? `\n\n(cut at ${offset + READ_LIMIT} of ${text.length} characters; read on with offset)` : "";
      return ok(slice + more, `Read ${path.basename(file)}`);
    },

    async view_image(args) {
      const { id } = args as { id: string };
      const node = (await getMulch(ctx.mulchId)).nodes[id];
      if (!node || node.kind !== "image" || !node.assetId) return fail(`${id} is not an image item. Image items have kind [image].`);
      try {
        const bytes = await fs.readFile(assetPath(ctx.mulchId, node.assetId));
        return { ...ok(`Image ${id}${node.fileName ? ` (${node.fileName})` : ""}.`, "Looked at an image"), images: [await imageForModel(bytes)] };
      } catch (error) {
        return fail(`Could not open the image: ${(error as Error).message}`);
      }
    },

    async caption_image(args) {
      const { id, title, text } = args as { id: string; title?: string; text: string };
      const node = (await getMulch(ctx.mulchId)).nodes[id];
      if (!node || node.kind !== "image") return fail(`${id} is not an image item.`);
      if (node.text && !ctx.allowUserEdits) return fail(`${id} already has a caption; leave it unless the person asks.`);
      const ops: MulchOp[] = [{ op: "updateNode", id, patch: { text, ...(title ? { title } : {}) } }];
      await commit(ops);
      return ok(`Captioned ${id}.`, "Captioned an image", ops);
    },
  };

  return {
    definitions,
    async execute(name, args) {
      if (!ctx.tools.includes(name as ToolName)) return fail(`Unknown tool ${name}.`);
      const parsed = schemas.get(name)!.safeParse(args ?? {});
      if (!parsed.success) return fail(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      try {
        return await handlers[name as ToolName](parsed.data as Record<string, unknown>);
      } catch (error) {
        return fail(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
