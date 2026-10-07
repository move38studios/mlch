/**
 * Applying and inverting napkin ops. Pure; shared by browser and server.
 *
 * applyOps never throws on a stale op (a node already removed, an edge to a
 * node that is gone): the op is skipped. Both sides apply the same batches in
 * the same order, so skipping is consistent.
 */

import type { Napkin, NapkinEdge, NapkinOp } from "./types";

export function emptyNapkin(id: string, title: string, now: number): Napkin {
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

export function applyOp(napkin: Napkin, op: NapkinOp): Napkin {
  switch (op.op) {
    case "addNode":
      if (napkin.nodes[op.node.id]) return napkin;
      return { ...napkin, nodes: { ...napkin.nodes, [op.node.id]: definedOnly(op.node) as typeof op.node } };
    case "updateNode": {
      const node = napkin.nodes[op.id];
      if (!node) return napkin;
      return { ...napkin, nodes: { ...napkin.nodes, [op.id]: merge(node, op.patch) } };
    }
    case "removeNode": {
      if (!napkin.nodes[op.id]) return napkin;
      const edges = Object.fromEntries(
        Object.entries(napkin.edges).filter(([, edge]) => edge.source !== op.id && edge.target !== op.id),
      );
      return { ...napkin, nodes: without(napkin.nodes, op.id), edges };
    }
    case "addEdge": {
      const { edge } = op;
      if (napkin.edges[edge.id] || !napkin.nodes[edge.source] || !napkin.nodes[edge.target] || edge.source === edge.target) {
        return napkin;
      }
      return { ...napkin, edges: { ...napkin.edges, [edge.id]: definedOnly(edge) as NapkinEdge } };
    }
    case "updateEdge": {
      const edge = napkin.edges[op.id];
      if (!edge) return napkin;
      return { ...napkin, edges: { ...napkin.edges, [op.id]: merge(edge, op.patch) } };
    }
    case "removeEdge":
      if (!napkin.edges[op.id]) return napkin;
      return { ...napkin, edges: without(napkin.edges, op.id) };
    case "addGroup":
      if (napkin.groups[op.group.id]) return napkin;
      return { ...napkin, groups: { ...napkin.groups, [op.group.id]: definedOnly(op.group) as typeof op.group } };
    case "updateGroup": {
      const group = napkin.groups[op.id];
      if (!group) return napkin;
      return { ...napkin, groups: { ...napkin.groups, [op.id]: merge(group, op.patch) } };
    }
    case "removeGroup": {
      if (!napkin.groups[op.id]) return napkin;
      const nodes = { ...napkin.nodes };
      for (const node of Object.values(nodes)) {
        if (node.groupId === op.id) nodes[node.id] = merge(node, { groupId: null });
      }
      return { ...napkin, nodes, groups: without(napkin.groups, op.id) };
    }
    case "setTitle":
      return { ...napkin, title: op.title };
    default:
      return napkin;
  }
}

export function applyOps(napkin: Napkin, ops: readonly NapkinOp[], now?: number): Napkin {
  let next = napkin;
  for (const op of ops) next = applyOp(next, op);
  if (next !== napkin && now !== undefined) next = { ...next, updatedAt: now };
  return next;
}

/**
 * The ops that undo `ops` when applied after them, given the napkin as it was
 * before them. Each op is inverted against the state it saw, and the
 * inverses run in reverse order.
 */
export function invertOps(before: Napkin, ops: readonly NapkinOp[]): NapkinOp[] {
  const inverses: NapkinOp[][] = [];
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

function invertOp(state: Napkin, op: NapkinOp): NapkinOp[] {
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
      return [{ op: "addNode", node }, ...edges.map((edge): NapkinOp => ({ op: "addEdge", edge }))];
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
        ...members.map((node): NapkinOp => ({ op: "updateNode", id: node.id, patch: { groupId: op.id } })),
      ];
    }
    case "setTitle":
      return [{ op: "setTitle", title: state.title }];
    default:
      return [];
  }
}
