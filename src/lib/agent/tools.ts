/**
 * The napkin tools the agent calls. Server-only.
 *
 * Every call that changes the napkin is applied straight to the live napkin
 * as one batch (one undo step in the window), with origin `agent:<jobId>`.
 * The model never gives coordinates: it names what a new item belongs near,
 * and place.ts finds the space. It cannot move, rewrite or remove anything
 * the user made or touched unless the job allows it (an explicit command).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { newClientId } from "@/lib/napkin/ids";
import { arrangeGroups, boundsOf, placeNear } from "@/lib/napkin/place";
import { artifactHeight, estimateHeight, NODE_WIDTH, rectOf, type Rect } from "@/lib/napkin/sizes";
import { applyToNapkin, atomicWriteFile, emit, getNapkin, napkinDir } from "@/lib/napkin/store";
import { NODE_KINDS, type Napkin, type NapkinNode, type NapkinOp, type NodeKind } from "@/lib/napkin/types";
import { assetPath, isImage } from "@/lib/ingest/ingest";
import { adoptArtifact, ARTIFACT_EXTENSIONS, ARTIFACT_PATH, artifactFile, saveArtifact } from "@/lib/artifacts/artifacts";
import { desktopRequest } from "@/lib/desktop/server";
import { modelSchema, searchModels } from "@/lib/media/fal";
import { startGeneration, waitFor } from "@/lib/media/generations";
import { viewForModel } from "@/lib/media/inspect";
import { checkBudget, estimateCost } from "@/lib/media/spend";
import { buildPptx, slideSchema, type Slide } from "@/lib/artifacts/pptx";
import { hiddenEntry, imageForModel, resolveReadable } from "./files";
import type { AgentToolDefinition, AgentToolResult, AgentToolRuntime } from "./types";

export type ToolName =
  | "get_napkin"
  | "add_nodes"
  | "connect"
  | "update_node"
  | "remove_nodes"
  | "arrange"
  | "write_doc"
  | "say"
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
  | "media_view";

export interface ToolContext {
  napkinId: string;
  jobId: string;
  tools: ToolName[];
  /** An explicit command may change what the user made. */
  allowUserEdits?: boolean;
  /** Folder the file tools may read: a picked folder, or the home folder for instructions. */
  readRoot?: string;
  /** For hand_off: queue a command job with this instruction. */
  onHandOff?: (instruction: string) => void;
  /** For make: queue a making job with this brief. */
  onMake?: (brief: string) => void;
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
}

/* ── describing the napkin to the model ────────────────────────── */

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function nodeLine(node: NapkinNode, textLimit: number): string {
  const r = rectOf(node);
  const flags = [
    node.userTouched || node.origin === "user" ? "user" : node.origin.startsWith("speech:") ? "said" : undefined,
    node.groupId ? `group=${node.groupId}` : undefined,
  ].filter(Boolean);
  const head = `${node.id} [${node.kind}] @${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  const body = [node.title ? `"${oneLine(node.title)}"` : undefined, node.url, clip(oneLine(node.text), textLimit)].filter(Boolean).join(" — ");
  return `${head}: ${body}`;
}

/** Compact text form of the napkin for prompts and get_napkin. */
export function describeNapkin(napkin: Napkin, options: { textLimit?: number; maxNodes?: number } = {}): string {
  const textLimit = options.textLimit ?? 220;
  const nodes = Object.values(napkin.nodes).sort((a, b) => a.createdAt - b.createdAt);
  const shown = options.maxNodes && nodes.length > options.maxNodes ? nodes.slice(-options.maxNodes) : nodes;
  const lines = [`Napkin "${napkin.title}" — ${nodes.length} items, ${Object.keys(napkin.edges).length} connections.`];
  if (shown.length < nodes.length) lines.push(`(Showing the newest ${shown.length}; call get_napkin for all.)`);
  const bounds = boundsOf(nodes.map(rectOf));
  if (bounds) lines.push(`Bounds: ${Math.round(bounds.x)},${Math.round(bounds.y)} to ${Math.round(bounds.x + bounds.w)},${Math.round(bounds.y + bounds.h)}`);
  if (!nodes.length) lines.push("(empty)");
  lines.push("", "Items:");
  for (const node of shown) lines.push(nodeLine(node, textLimit));
  const edges = Object.values(napkin.edges);
  if (edges.length) {
    lines.push("", "Connections:");
    for (const edge of edges) lines.push(`${edge.source} -> ${edge.target}${edge.label ? ` (${edge.label})` : ""}`);
  }
  const groups = Object.values(napkin.groups);
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

const AI_KINDS = NODE_KINDS.filter((kind) => !["doc", "image", "note", "artifact", "writeup", "media"].includes(kind)) as [NodeKind, ...NodeKind[]];

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

const DEFINITIONS: Record<ToolName, AgentToolDefinition> = {
  get_napkin: {
    name: "get_napkin",
    title: "Read napkin",
    description: "The whole napkin: every item with id, kind, position, size, who made it, and text; connections; groups.",
    inputShape: {},
    readOnly: true,
  },
  add_nodes: {
    name: "add_nodes",
    title: "Add items",
    description:
      "Add items to the napkin and optionally connect them, in one call. Never give coordinates: name what each item belongs `near` " +
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
    title: "Remove items",
    description: "Remove items (and their connections). Items the user made or touched can only be removed when the user asked for it.",
    inputShape: { ids: z.array(z.string()).min(1).max(100) },
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
    description: "Write a markdown document (summary, write-up, outline) and put it on the napkin as a write-up card, saved as a file in the napkin's docs folder.",
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
    description: "Show the user one short status line (under 15 words). Not for content; content goes on the napkin.",
    inputShape: { text: z.string().max(200) },
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
    title: "Name napkin",
    description: "Name the napkin: 2-5 plain words for what it is about.",
    inputShape: { title: z.string().min(1).max(60) },
    readOnly: false,
  },
  write_artifact: {
    name: "write_artifact",
    title: "Make file",
    description:
      "Save a file you wrote (an HTML page or slide deck, SVG, markdown, CSV, JSON, text) in the napkin's artifacts folder and put a card for it on the napkin. " +
      "HTML opens full-window inside npkn and must be self-contained: inline CSS and JS; scripts and styles only from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com; fonts from Google Fonts; " +
      "images only as data: URIs. It cannot fetch anything at runtime and cannot open other pages.",
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
    description: "Build a PowerPoint (.pptx) deck from a list of slides, save it in the napkin's artifacts folder and put a card for it on the napkin. Layout and styling are done for you.",
    inputShape: {
      title: z.string().max(120),
      slides: z.array(slideSchema).min(1).max(60),
      accent: z.string().max(7).optional().describe("Accent colour as hex, e.g. D2491F."),
      description: z.string().max(400).describe("One or two sentences for the card."),
      near: z.array(z.string()).max(6).optional(),
    },
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
      "Start a generation on fal. Puts a card on the napkin right away that shows progress; returns the generation id without waiting. " +
      "To use napkin items as inputs (an image to animate or edit, audio, video), put \"napkin:<item id>\" where the schema wants a URL. " +
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
    description: "See a media or image item on the napkin (images as images, video as frames, speech transcribed, 3D from four sides).",
    inputShape: { id: z.string() },
    readOnly: true,
  },
  make: {
    name: "make",
    title: "Make with tools",
    description:
      "Start a making job: Claude Code or Codex with its own shell and file tools in a sandbox (Python, python-pptx, node, and so on), for files that need real tools: " +
      "PowerPoint decks, Word or PDF documents, spreadsheets, charts. It saves results in the napkin's artifacts folder and they appear on the napkin. " +
      "Give a complete brief: what to make, for whom, the format, and which napkin items it should draw on.",
    inputShape: { brief: z.string().min(10).max(8000) },
    readOnly: true,
  },
  present_file: {
    name: "present_file",
    title: "Put file on napkin",
    description: "Put a card on the napkin for a file you saved in the artifacts folder (path relative to it, e.g. deck.pptx).",
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
    description: "See an image item on the napkin (by id).",
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

const ok = (text: string, summary: string, ops: NapkinOp[] = []): AgentToolResult => ({ ok: true, text, summary, ops });
const fail = (text: string): AgentToolResult => ({ ok: false, text, summary: "Failed", ops: [] });

/** Made, said or touched by the person. */
function isUserOwned(node: NapkinNode): boolean {
  return node.origin === "user" || node.origin.startsWith("speech:") || !!node.userTouched;
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

const READ_LIMIT = 30_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".venv"]);

export function createNapkinTools(ctx: ToolContext): AgentToolRuntime {
  const origin = ctx.origin ?? `agent:${ctx.jobId}`;
  const definitions = ctx.tools.map((name) => DEFINITIONS[name]);
  const schemas = new Map(definitions.map((definition) => [definition.name, z.object(definition.inputShape)]));

  async function commit(ops: NapkinOp[]) {
    if (ops.length) await applyToNapkin(ctx.napkinId, ops, origin);
  }

  function resolver(napkin: Napkin, refs: Map<string, string>) {
    return (key: string) => refs.get(key) ?? (napkin.nodes[key] ? key : undefined);
  }

  function edgeOps(napkin: Napkin, edges: z.infer<typeof edgeShape>[], resolve: (key: string) => string | undefined, problems: string[]) {
    const ops: NapkinOp[] = [];
    const existing = new Set(Object.values(napkin.edges).map((edge) => `${edge.source}>${edge.target}`));
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

  async function addArtifactCard(title: string, description: string, docPath: string, near?: string[]): Promise<string> {
    const napkin = await getNapkin(ctx.napkinId);
    const id = newClientId("n");
    const anchors = (near ?? []).filter((key) => napkin.nodes[key]);
    const position = placeNear(napkin, { w: NODE_WIDTH.artifact, h: artifactHeight(docPath) }, { anchorIds: anchors, seed: id });
    await commit([
      { op: "addNode", node: { id, kind: "artifact", x: position.x, y: position.y, title, text: description, docPath, fileName: path.basename(docPath), origin, createdAt: Date.now() } },
    ]);
    ctx.added.push(id);
    return id;
  }

  async function viewNode(id: string): Promise<{ text: string; images: NonNullable<AgentToolResult["images"]> }> {
    const node = (await getNapkin(ctx.napkinId)).nodes[id];
    if (!node?.assetId) return { text: `${id} has no media file${node?.gen ? ` (generation ${node.gen.status})` : ""}.`, images: [] };
    return viewForModel(assetPath(ctx.napkinId, node.assetId), node.mime, `/api/napkins/${ctx.napkinId}/model-view/${node.assetId}`);
  }

  const handlers: Record<ToolName, (args: Record<string, unknown>) => Promise<AgentToolResult>> = {
    async get_napkin() {
      return ok(describeNapkin(await getNapkin(ctx.napkinId)), "Read the napkin");
    },

    async add_nodes(args) {
      const input = args as { nodes: z.infer<typeof newNodeShape>[]; edges?: z.infer<typeof edgeShape>[] };
      let napkin = await getNapkin(ctx.napkinId);
      const refs = new Map<string, string>();
      const problems: string[] = [];
      const ops: NapkinOp[] = [];
      const pending: Rect[] = [];
      const created: NapkinNode[] = [];
      for (const item of input.nodes) {
        const id = newClientId("n");
        if (item.ref) refs.set(item.ref, id);
        const resolve = resolver(napkin, refs);
        const anchors = (item.near ?? []).map(resolve).filter((x): x is string => !!x);
        const unknown = (item.near ?? []).filter((key) => !resolve(key));
        if (unknown.length) problems.push(`near: unknown ${unknown.join(", ")} (placed anyway).`);
        // Anchors added earlier in this call are not on the napkin yet; use their pending boxes.
        const view: Napkin = { ...napkin, nodes: { ...napkin.nodes, ...Object.fromEntries(created.map((n) => [n.id, n])) } };
        const w = NODE_WIDTH[item.kind];
        const h = estimateHeight(item.kind, item.text, item.title);
        const group = item.group && napkin.groups[item.group] ? item.group : undefined;
        const position = placeNear(view, { w, h }, { anchorIds: anchors, seed: id, taken: pending });
        pending.push({ ...position, w, h });
        const node: NapkinNode = {
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
      napkin = { ...napkin, nodes: { ...napkin.nodes, ...Object.fromEntries(created.map((n) => [n.id, n])) } };
      ops.push(...edgeOps(napkin, input.edges ?? [], resolver(napkin, refs), problems));
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
      const napkin = await getNapkin(ctx.napkinId);
      const problems: string[] = [];
      const ops = edgeOps(napkin, (args as { edges: z.infer<typeof edgeShape>[] }).edges, resolver(napkin, new Map()), problems);
      await commit(ops);
      return ok(`Made ${ops.length} connections.${problems.length ? ` ${problems.join(" ")}` : ""}`, `Connected ${ops.length}`, ops);
    },

    async update_node(args) {
      const { id, title, text } = args as { id: string; title?: string; text?: string };
      const napkin = await getNapkin(ctx.napkinId);
      const node = napkin.nodes[id];
      if (!node) return fail(`No item ${id}. Call get_napkin for current ids.`);
      if (isUserOwned(node) && !ctx.allowUserEdits) return fail(`${id} was made or edited by the user; leave it as it is unless they ask you to change it.`);
      if (title === undefined && text === undefined) return fail("Give a new title or text.");
      const ops: NapkinOp[] = [{ op: "updateNode", id, patch: { ...(title !== undefined ? { title } : {}), ...(text !== undefined ? { text } : {}), updatedAt: Date.now() } }];
      await commit(ops);
      return ok(`Updated ${id}.`, "Edited an item", ops);
    },

    async remove_nodes(args) {
      const { ids } = args as { ids: string[] };
      const napkin = await getNapkin(ctx.napkinId);
      const refused: string[] = [];
      const missing: string[] = [];
      const ops: NapkinOp[] = [];
      for (const id of ids) {
        const node = napkin.nodes[id];
        if (!node) missing.push(id);
        else if (isUserOwned(node) && !ctx.allowUserEdits) refused.push(id);
        else ops.push({ op: "removeNode", id });
      }
      await commit(ops);
      const notes = [
        refused.length ? `Kept ${refused.join(", ")}: made or edited by the user.` : "",
        missing.length ? `Not found: ${missing.join(", ")}.` : "",
      ].filter(Boolean);
      return ok(`Removed ${ops.length}. ${notes.join(" ")}`.trim(), `Removed ${ops.length}`, ops);
    },

    async arrange(args) {
      const { groups } = args as { groups: Array<{ title: string; ids: string[] }> };
      const napkin = await getNapkin(ctx.napkinId);
      const ids = groups.flatMap((group) => group.ids);
      const missing = ids.filter((id) => !napkin.nodes[id]);
      const userMoved = ids.filter((id) => napkin.nodes[id] && isUserOwned(napkin.nodes[id]));
      if (userMoved.length && !ctx.allowUserEdits) return fail(`The user placed ${userMoved.join(", ")}; leave them where they are unless they ask you to arrange.`);
      const { moves, boxes } = arrangeGroups(napkin, groups.map((group) => ({ title: group.title, nodeIds: group.ids })));
      if (!moves.length) return fail(`Nothing to arrange. Unknown ids: ${missing.join(", ")}. Call get_napkin for current ids.`);
      const moving = new Set(moves.map((move) => move.id));
      const ops: NapkinOp[] = [];
      // Groups whose members all move are replaced by the new boxes.
      for (const group of Object.values(napkin.groups)) {
        const members = Object.values(napkin.nodes).filter((node) => node.groupId === group.id);
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
      const napkin = await getNapkin(ctx.napkinId);
      const docs = path.join(napkinDir(ctx.napkinId), "docs");
      await fs.mkdir(docs, { recursive: true });
      let slug = slugify(title);
      const existing = new Set(await fs.readdir(docs).catch(() => [] as string[]));
      for (let i = 2; existing.has(`${slug}.md`); i++) slug = `${slugify(title)}-${i}`;
      const docPath = `docs/${slug}.md`;
      await atomicWriteFile(path.join(napkinDir(ctx.napkinId), docPath), markdown.startsWith("#") ? markdown : `# ${title}\n\n${markdown}`);
      const id = newClientId("n");
      const anchors = (near ?? []).filter((key) => napkin.nodes[key]);
      const w = NODE_WIDTH.writeup;
      const position = placeNear(napkin, { w, h: 260 }, { anchorIds: anchors, seed: id });
      const ops: NapkinOp[] = [
        { op: "addNode", node: { id, kind: "writeup", x: position.x, y: position.y, title, text: markdown, docPath, origin, createdAt: Date.now() } },
      ];
      await commit(ops);
      ctx.added.push(id);
      return ok(`Wrote ${docPath} and added write-up ${id}.`, `Wrote "${title}"`, ops);
    },

    async say(args) {
      await emit(ctx.napkinId, { type: "say", text: (args as { text: string }).text, jobId: ctx.jobId });
      return ok("Shown.", "Status");
    },

    async hand_off(args) {
      const { instruction } = args as { instruction: string };
      if (!ctx.onHandOff) return fail("Not available here.");
      ctx.onHandOff(instruction);
      return ok("Queued as a command.", "Handed off");
    },

    async set_title(args) {
      const napkin = await getNapkin(ctx.napkinId);
      // Only names an unnamed napkin; the person's own title stays.
      if (napkin.title !== "Untitled") return ok("The napkin already has a name.", "Kept name");
      const ops: NapkinOp[] = [{ op: "setTitle", title: (args as { title: string }).title.trim() }];
      await commit(ops);
      return ok("Named.", "Named the napkin", ops);
    },

    async write_artifact(args) {
      const { title, extension, content, description, near, replace } = args as {
        title: string; extension: string; content: string; description: string; near?: string[]; replace?: string;
      };
      if (replace) {
        const napkin = await getNapkin(ctx.napkinId);
        const node = Object.values(napkin.nodes).find((n) => n.kind === "artifact" && n.docPath === replace);
        if (!node || !ARTIFACT_PATH.test(replace) || !replace.endsWith(`.${extension}`)) return fail(`No artifact ${replace} with extension ${extension} on the napkin.`);
        if (isUserOwned(node) && !ctx.allowUserEdits) return fail(`${replace} belongs to the person.`);
        await atomicWriteFile(artifactFile(ctx.napkinId, replace), content);
        await commit([{ op: "updateNode", id: node.id, patch: { title, text: description, updatedAt: Date.now() } }]);
        return ok(`Replaced ${replace}.`, `Revised ${title}`);
      }
      const docPath = await saveArtifact(ctx.napkinId, title, extension, Buffer.from(content));
      const id = await addArtifactCard(title, description, docPath, near);
      return ok(`Saved ${docPath} and added card ${id}.`, `Made ${title}`, []);
    },

    async make_pptx(args) {
      const { title, slides, accent, description, near } = args as { title: string; slides: Slide[]; accent?: string; description: string; near?: string[] };
      const napkin = await getNapkin(ctx.napkinId);
      const bytes = await buildPptx(title, slides, { accent: accent?.replace("#", "") }, async (imageId) => {
        const node = napkin.nodes[imageId];
        if (node?.kind !== "image" || !node.assetId) return undefined;
        return imageForModel(await fs.readFile(assetPath(ctx.napkinId, node.assetId)));
      });
      const docPath = await saveArtifact(ctx.napkinId, title, "pptx", bytes);
      const id = await addArtifactCard(title, `${description}\n\n${slides.length} slides`, docPath, near);
      return ok(`Saved ${docPath} (${slides.length} slides) and added card ${id}.`, `Made ${title}.pptx`, []);
    },

    async preview_artifact(args) {
      const { path: file, slides = 1 } = args as { path: string; slides?: number };
      const docPath = file.startsWith("artifacts/") ? file : `artifacts/${file}`;
      if (!ARTIFACT_PATH.test(docPath) || !/\.(html|svg)$/.test(docPath)) return fail("Only HTML and SVG artifacts can be previewed.");
      const result = await desktopRequest("render", { url: `/api/napkins/${ctx.napkinId}/${docPath}`, steps: slides });
      if (!result.ok) return fail(`Could not render it: ${result.error}`);
      const value = result.value as { images: string[]; errors: string[] };
      const errors = value.errors.length ? `Script errors and warnings:\n${value.errors.join("\n")}` : "No script errors.";
      return {
        ...ok(`${value.images.length} screenshot(s) of ${docPath}, in order. ${errors}`, `Looked at ${path.basename(docPath)}`),
        images: value.images.map((data) => ({ data, mimeType: "image/png" })),
      };
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
        napkinId: ctx.napkinId,
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
      const napkin = await getNapkin(ctx.napkinId);
      const genIds: string[] = [];
      for (const id of ids) {
        const gen = napkin.nodes[id]?.gen?.id ?? id;
        genIds.push(gen);
      }
      const records = await waitFor(ctx.napkinId, genIds, max_seconds * 1000);
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
      ctx.onMake((args as { brief: string }).brief);
      return ok("Making job queued. Its files will appear on the napkin when done.", "Started making");
    },

    async present_file(args) {
      const { path: file, title, description, near } = args as { path: string; title: string; description: string; near?: string[] };
      const docPath = await adoptArtifact(ctx.napkinId, file.replace(/^artifacts\//, "").split("/").pop() ?? "");
      if (!docPath) return fail(`No such file in the artifacts folder, or not a supported type (${ARTIFACT_EXTENSIONS.join(", ")}). Save it there first.`);
      const napkin = await getNapkin(ctx.napkinId);
      if (Object.values(napkin.nodes).some((node) => node.docPath === docPath)) return ok(`${docPath} is already on the napkin.`, "Already there");
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
      const node = (await getNapkin(ctx.napkinId)).nodes[id];
      if (!node || node.kind !== "image" || !node.assetId) return fail(`${id} is not an image item. Image items have kind [image].`);
      try {
        const bytes = await fs.readFile(assetPath(ctx.napkinId, node.assetId));
        return { ...ok(`Image ${id}${node.fileName ? ` (${node.fileName})` : ""}.`, "Looked at an image"), images: [await imageForModel(bytes)] };
      } catch (error) {
        return fail(`Could not open the image: ${(error as Error).message}`);
      }
    },

    async caption_image(args) {
      const { id, title, text } = args as { id: string; title?: string; text: string };
      const node = (await getNapkin(ctx.napkinId)).nodes[id];
      if (!node || node.kind !== "image") return fail(`${id} is not an image item.`);
      if (node.text && !ctx.allowUserEdits) return fail(`${id} already has a caption; leave it unless the person asks.`);
      const ops: NapkinOp[] = [{ op: "updateNode", id, patch: { text, ...(title ? { title } : {}) } }];
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
