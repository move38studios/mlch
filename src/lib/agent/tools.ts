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
import { estimateHeight, NODE_WIDTH, rectOf, type Rect } from "@/lib/napkin/sizes";
import { applyToNapkin, atomicWriteFile, emit, getNapkin, napkinDir } from "@/lib/napkin/store";
import { NODE_KINDS, type Napkin, type NapkinNode, type NapkinOp, type NodeKind } from "@/lib/napkin/types";
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
  | "list_files"
  | "read_file";

export interface ToolContext {
  napkinId: string;
  jobId: string;
  tools: ToolName[];
  /** An explicit command may change what the user made. */
  allowUserEdits?: boolean;
  /** Folder the file tools may read (folder ingestion). */
  readRoot?: string;
  /** For hand_off: queue a command job with this instruction. */
  onHandOff?: (instruction: string) => void;
  /** Ids of nodes this job added, in order. */
  added: string[];
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

const AI_KINDS = NODE_KINDS.filter((kind) => kind !== "doc" && kind !== "image" && kind !== "note") as [NodeKind, ...NodeKind[]];

const newNodeShape = z.object({
  ref: z.string().max(40).optional().describe("Your temporary name for this item, to connect it to others in the same call."),
  kind: z.enum(AI_KINDS).describe("idea | question | search | definition | example | link | writeup"),
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
  list_files: {
    name: "list_files",
    title: "List files",
    description: "List files and folders under a path inside the folder being explored (relative path, '' for the top).",
    inputShape: { path: z.string().max(1000) },
    readOnly: true,
  },
  read_file: {
    name: "read_file",
    title: "Read file",
    description: "Read a text file inside the folder being explored (relative path). Long files are cut; pass `offset` (characters) to read further.",
    inputShape: { path: z.string().max(1000), offset: z.number().int().min(0).optional() },
    readOnly: true,
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

/** Resolve a path inside root, or undefined if it escapes. */
function inside(root: string, relative: string): string | undefined {
  const target = path.resolve(root, relative.replace(/^\/+/, ""));
  return target === root || target.startsWith(root + path.sep) ? target : undefined;
}

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

    async list_files(args) {
      if (!ctx.readRoot) return fail("No folder to explore.");
      const dir = inside(ctx.readRoot, (args as { path: string }).path || "");
      if (!dir) return fail("That path is outside the folder.");
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
      return ok(lines.join("\n") || "(empty)", `Listed ${lines.length}`);
    },

    async read_file(args) {
      if (!ctx.readRoot) return fail("No folder to explore.");
      const { path: relative, offset = 0 } = args as { path: string; offset?: number };
      const file = inside(ctx.readRoot, relative);
      if (!file) return fail("That path is outside the folder.");
      const { readText } = await import("@/lib/ingest/extract");
      const text = await readText(file).catch((error: Error) => `(could not read: ${error.message})`);
      const slice = text.slice(offset, offset + READ_LIMIT);
      const more = offset + READ_LIMIT < text.length ? `\n\n(cut at ${offset + READ_LIMIT} of ${text.length} characters; read on with offset)` : "";
      return ok(slice + more, `Read ${path.basename(file)}`);
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
