/**
 * The napkin document: a flat board of nodes, edges and groups.
 *
 * Shared by the browser and the server. Every change is an op (NapkinOp),
 * applied by the same pure function on both sides (ops.ts), logged to the
 * napkin's events.jsonl and broadcast to open windows.
 *
 * Coordinates are React Flow's: `x`/`y` are the TOP-LEFT corner of the box in
 * flow units. `w`/`h` are the measured size once the canvas has rendered the
 * node, otherwise the per-kind fallback in sizes.ts.
 */

export type NodeKind =
  /** A point from speech or typing. */
  | "idea"
  /** Post-it with an open question. */
  | "question"
  /** Web search result. */
  | "search"
  | "definition"
  | "example"
  /** A dropped file. */
  | "doc"
  /** A dropped URL. */
  | "link"
  | "image"
  /** Markdown produced by the AI. */
  | "writeup"
  /** Free text the user typed onto the canvas. */
  | "note";

export const NODE_KINDS: readonly NodeKind[] = [
  "idea",
  "question",
  "search",
  "definition",
  "example",
  "doc",
  "link",
  "image",
  "writeup",
  "note",
];

/**
 * Who made something: `user`, `speech:<segmentId>`, `agent:<jobId>`,
 * `ingest:<assetId>`.
 */
export type Origin = string;

export interface NapkinNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  w?: number;
  h?: number;
  /** Short heading. Optional for ideas and notes, whose text is the content. */
  title?: string;
  /** Body text (markdown allowed for writeups and docs). */
  text: string;
  url?: string;
  /** Content hash of a file in the napkin's assets/ folder. */
  assetId?: string;
  /** File name shown for doc and image nodes. */
  fileName?: string;
  /** Path of a write-up relative to the napkin folder (docs/<slug>.md). */
  docPath?: string;
  groupId?: string;
  origin: Origin;
  /**
   * The user created, moved or edited it. The AI never moves or rewrites a
   * touched node unless the user asks for it in a command.
   */
  userTouched?: boolean;
  createdAt: number;
  updatedAt?: number;
}

export interface NapkinEdge {
  id: string;
  source: string;
  target: string;
  /** How the two relate, a few words ("contradicts", "example of"). */
  label?: string;
  origin: Origin;
  createdAt: number;
}

export interface NapkinGroup {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  origin: Origin;
  userTouched?: boolean;
  createdAt: number;
}

export interface Napkin {
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodes: Record<string, NapkinNode>;
  edges: Record<string, NapkinEdge>;
  groups: Record<string, NapkinGroup>;
}

/** What the home screen lists. */
export interface NapkinSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

type NodePatch = Partial<Omit<NapkinNode, "id" | "createdAt">>;
type GroupPatch = Partial<Omit<NapkinGroup, "id" | "createdAt">>;

export type NapkinOp =
  | { op: "addNode"; node: NapkinNode }
  /** Shallow merge. Moves and resizes are updates too. */
  | { op: "updateNode"; id: string; patch: NodePatch }
  /** Also removes the node's edges. */
  | { op: "removeNode"; id: string }
  | { op: "addEdge"; edge: NapkinEdge }
  | { op: "updateEdge"; id: string; patch: { label?: string } }
  | { op: "removeEdge"; id: string }
  | { op: "addGroup"; group: NapkinGroup }
  | { op: "updateGroup"; id: string; patch: GroupPatch }
  /** Nodes in it stay where they are and leave the group. */
  | { op: "removeGroup"; id: string }
  | { op: "setTitle"; title: string };

/** A batch of ops as logged and broadcast. */
export interface OpBatch {
  /** Unique per batch. */
  id: string;
  napkinId: string;
  ops: NapkinOp[];
  /** `user`, or the job that produced it. */
  origin: Origin;
  /** The browser tab that sent it, so it can skip its own echo. */
  clientId?: string;
  at: number;
}
