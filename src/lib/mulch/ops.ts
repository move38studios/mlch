/**
 * Applying and inverting mulch ops. Pure; shared by browser and server.
 *
 * applyOps never throws on a stale op (a node already removed, an edge to a
 * node that is gone): the op is skipped. Both sides apply the same batches in
 * the same order, so skipping is consistent.
 */

import type { Mulch, MulchEdge, MulchOp } from "./types";

export function emptyMulch(id: string, title: string, now: number): Mulch {
  return { version: 1, id, title, createdAt: now, updatedAt: now, nodes: {}, edges: {}, groups: {} };
}

function without<T>(record: Record<string, T>, id: string): Record<string, T> {
  const next = { ...record };
  delete next[id];
  return next;
}

function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** Merge a patch where `null` clears a field. */
function merge<T extends object>(base: T, patch: object): T {
  const next = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next as T;
}

export function applyOp(mulch: Mulch, op: MulchOp): Mulch {
  switch (op.op) {
    case "addNode":
      if (mulch.nodes[op.node.id]) return mulch;
      return { ...mulch, nodes: { ...mulch.nodes, [op.node.id]: definedOnly(op.node) as typeof op.node } };
    case "updateNode": {
      const node = mulch.nodes[op.id];
      if (!node) return mulch;
      return { ...mulch, nodes: { ...mulch.nodes, [op.id]: merge(node, op.patch) } };
    }
    case "removeNode": {
      if (!mulch.nodes[op.id]) return mulch;
      const edges = Object.fromEntries(
        Object.entries(mulch.edges).filter(([, edge]) => edge.source !== op.id && edge.target !== op.id),
      );
      return { ...mulch, nodes: without(mulch.nodes, op.id), edges };
    }
    case "addEdge": {
      const { edge } = op;
      if (mulch.edges[edge.id] || !mulch.nodes[edge.source] || !mulch.nodes[edge.target] || edge.source === edge.target) {
        return mulch;
      }
      return { ...mulch, edges: { ...mulch.edges, [edge.id]: definedOnly(edge) as MulchEdge } };
    }
    case "updateEdge": {
      const edge = mulch.edges[op.id];
      if (!edge) return mulch;
      return { ...mulch, edges: { ...mulch.edges, [op.id]: merge(edge, op.patch) } };
    }
    case "removeEdge":
      if (!mulch.edges[op.id]) return mulch;
      return { ...mulch, edges: without(mulch.edges, op.id) };
    case "addGroup":
      if (mulch.groups[op.group.id]) return mulch;
      return { ...mulch, groups: { ...mulch.groups, [op.group.id]: definedOnly(op.group) as typeof op.group } };
    case "updateGroup": {
      const group = mulch.groups[op.id];
      if (!group) return mulch;
      return { ...mulch, groups: { ...mulch.groups, [op.id]: merge(group, op.patch) } };
    }
    case "removeGroup": {
      if (!mulch.groups[op.id]) return mulch;
      const nodes = { ...mulch.nodes };
      for (const node of Object.values(nodes)) {
        if (node.groupId === op.id) nodes[node.id] = merge(node, { groupId: null });
      }
      return { ...mulch, nodes, groups: without(mulch.groups, op.id) };
    }
    case "setTitle":
      return { ...mulch, title: op.title };
    case "addComment":
      if (mulch.comments?.[op.comment.id]) return mulch;
      return { ...mulch, comments: { ...mulch.comments, [op.comment.id]: definedOnly(op.comment) as typeof op.comment } };
    case "updateComment": {
      const comment = mulch.comments?.[op.id];
      if (!comment) return mulch;
      return { ...mulch, comments: { ...mulch.comments, [op.id]: merge(comment, op.patch) } };
    }
    case "removeComment":
      if (!mulch.comments?.[op.id]) return mulch;
      return { ...mulch, comments: without(mulch.comments, op.id) };
    default:
      return mulch;
  }
}

export function applyOps(mulch: Mulch, ops: readonly MulchOp[], now?: number): Mulch {
  let next = mulch;
  for (const op of ops) next = applyOp(next, op);
  if (next !== mulch && now !== undefined) next = { ...next, updatedAt: now };
  return next;
}

/**
 * The ops that undo `ops` when applied after them, given the mulch as it was
 * before them. Each op is inverted against the state it saw, and the
 * inverses run in reverse order.
 */
export function invertOps(before: Mulch, ops: readonly MulchOp[]): MulchOp[] {
  const inverses: MulchOp[][] = [];
  let state = before;
  for (const op of ops) {
    inverses.push(invertOp(state, op));
    state = applyOp(state, op);
  }
  return inverses.reverse().flat();
}

function previousValues(base: object, patch: object): Record<string, unknown> {
  const record = base as Record<string, unknown>;
  // A field that was absent is cleared again with null.
  return Object.fromEntries(Object.keys(patch).map((key) => [key, key in record ? record[key] : null]));
}

function invertOp(state: Mulch, op: MulchOp): MulchOp[] {
  switch (op.op) {
    case "addNode":
      return state.nodes[op.node.id] ? [] : [{ op: "removeNode", id: op.node.id }];
    case "updateNode": {
      const node = state.nodes[op.id];
      return node ? [{ op: "updateNode", id: op.id, patch: previousValues(node, op.patch) }] : [];
    }
    case "removeNode": {
      const node = state.nodes[op.id];
      if (!node) return [];
      const edges = Object.values(state.edges).filter((edge) => edge.source === op.id || edge.target === op.id);
      return [{ op: "addNode", node }, ...edges.map((edge): MulchOp => ({ op: "addEdge", edge }))];
    }
    case "addEdge":
      return state.edges[op.edge.id] ? [] : [{ op: "removeEdge", id: op.edge.id }];
    case "updateEdge": {
      const edge = state.edges[op.id];
      return edge ? [{ op: "updateEdge", id: op.id, patch: previousValues(edge, op.patch) as { label?: string | null } }] : [];
    }
    case "removeEdge": {
      const edge = state.edges[op.id];
      return edge ? [{ op: "addEdge", edge }] : [];
    }
    case "addGroup":
      return state.groups[op.group.id] ? [] : [{ op: "removeGroup", id: op.group.id }];
    case "updateGroup": {
      const group = state.groups[op.id];
      return group ? [{ op: "updateGroup", id: op.id, patch: previousValues(group, op.patch) }] : [];
    }
    case "removeGroup": {
      const group = state.groups[op.id];
      if (!group) return [];
      const members = Object.values(state.nodes).filter((node) => node.groupId === op.id);
      return [
        { op: "addGroup", group },
        ...members.map((node): MulchOp => ({ op: "updateNode", id: node.id, patch: { groupId: op.id } })),
      ];
    }
    case "setTitle":
      return [{ op: "setTitle", title: state.title }];
    case "addComment":
      return state.comments?.[op.comment.id] ? [] : [{ op: "removeComment", id: op.comment.id }];
    case "updateComment": {
      const comment = state.comments?.[op.id];
      return comment ? [{ op: "updateComment", id: op.id, patch: previousValues(comment, op.patch) }] : [];
    }
    case "removeComment": {
      const comment = state.comments?.[op.id];
      return comment ? [{ op: "addComment", comment }] : [];
    }
    default:
      return [];
  }
}
