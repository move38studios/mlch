/**
 * The mulch document: a flat board of nodes, edges and groups.
 *
 * Shared by the browser and the server. Every change is an op (MulchOp),
 * applied by the same pure function on both sides (ops.ts), logged to the
 * mulch's events.jsonl and broadcast to open windows.
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
  /** A file the AI made: an HTML page or deck, a PowerPoint, … (in artifacts/). */
  | "artifact"
  /** Generated image, video, audio or 3D model (fal). */
  | "media"
  /** Free text the user typed onto the canvas. */
  | "note"
  /** A link to an item in another mulch or a file in a linked folder; shows the target live, copies nothing. */
  | "ref";

/** What a link card points at. Ids only, no local paths beyond a source-relative one, so it survives sharing. */
export type NodeRef = { mulchId: string; itemId: string } | { sourceId: string; path: string };

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
  "artifact",
  "media",
  "note",
  "ref",
];

/**
 * Who made something: `user`, `speech:<segmentId>`, `agent:<jobId>`,
 * `ingest:<assetId>`.
 */
export type Origin = string;

export interface MulchNode {
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
  /** Content hash of a file in the mulch's assets/ folder. */
  assetId?: string;
  /** File name shown for doc and image nodes. */
  fileName?: string;
  /** File the item stands for, relative to the mulch folder (docs/<slug>.md, artifacts/<slug>.html). */
  docPath?: string;
  groupId?: string;
  /** MIME type of the file in assetId (media items). */
  mime?: string;
  /** Video links: the video's poster image (an asset), shown until it plays. */
  poster?: string;
  /** A generation in progress or finished (media items). */
  gen?: GenerationState;
  origin: Origin;
  /**
   * The user created, moved or edited it. The AI never moves or rewrites a
   * touched node unless the user asks for it in a command.
   */
  userTouched?: boolean;
  /** Link cards: the target. `title` keeps its title from when it was linked, for when it is gone or not shared. */
  ref?: NodeRef;
  createdAt: number;
  updatedAt?: number;
}

export interface GenerationState {
  id: string;
  /** fal endpoint, e.g. fal-ai/flux/schnell */
  endpoint: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  /** Place in fal's queue while queued. */
  position?: number;
  /** Last log line while running. */
  log?: string;
  error?: string;
  /** Estimated cost in USD. */
  cost?: number;
  startedAt: number;
  finishedAt?: number;
}

export interface MulchEdge {
  id: string;
  source: string;
  target: string;
  /** How the two relate, a few words ("contradicts", "example of"). */
  label?: string;
  origin: Origin;
  createdAt: number;
}

export interface MulchGroup {
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

export interface Mulch {
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodes: Record<string, MulchNode>;
  edges: Record<string, MulchEdge>;
  groups: Record<string, MulchGroup>;
}

/** What the home screen lists. */
export interface MulchSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  /** The person's instructions and long work: running, finished unseen, failed unseen. */
  activity?: { working: number; unseen: number; failed: number };
  /** Archived: out of the list, kept on disk, can be restored. */
  archivedAt?: number;
  /** Share links made from it that still work. */
  shares?: number;
}

/** A field set to null is cleared. */
type Patch<T> = { [K in keyof T]?: T[K] | null };
export type NodePatch = Patch<Omit<MulchNode, "id" | "createdAt">>;
export type GroupPatch = Patch<Omit<MulchGroup, "id" | "createdAt">>;

export type MulchOp =
  | { op: "addNode"; node: MulchNode }
  /** Shallow merge. Moves and resizes are updates too. */
  | { op: "updateNode"; id: string; patch: NodePatch }
  /** Also removes the node's edges. */
  | { op: "removeNode"; id: string }
  | { op: "addEdge"; edge: MulchEdge }
  | { op: "updateEdge"; id: string; patch: { label?: string | null } }
  | { op: "removeEdge"; id: string }
  | { op: "addGroup"; group: MulchGroup }
  | { op: "updateGroup"; id: string; patch: GroupPatch }
  /** Nodes in it stay where they are and leave the group. */
  | { op: "removeGroup"; id: string }
  | { op: "setTitle"; title: string };

/** A batch of ops as logged and broadcast. */
export interface OpBatch {
  /** Unique per batch. */
  id: string;
  mulchId: string;
  ops: MulchOp[];
  /** `user`, or the job that produced it. */
  origin: Origin;
  /** The browser tab that sent it, so it can skip its own echo. */
  clientId?: string;
  at: number;
}
