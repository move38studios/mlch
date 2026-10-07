/**
 * Deterministic geometry. The AI decides what relates to what; this module
 * decides where things go. Pure; shared by browser and server.
 *
 * Coordinates are always TOP-LEFT corners (see types.ts).
 */

import { overlaps, rectOf, type Rect } from "./sizes";
import type { Mulch, MulchNode } from "./types";

/** Space kept between boxes. */
export const GAP = 36;

/** Seeded jitter so the same id always gets the same nudge. Returns ±n/2. */
export function jitter(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (n: number) => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    return (((h >>> 0) % 1000) / 1000) * n - n / 2;
  };
}

function occupied(mulch: Mulch, ignore: ReadonlySet<string> = new Set()): Rect[] {
  const rects = Object.values(mulch.nodes)
    .filter((node) => !ignore.has(node.id))
    .map(rectOf);
  // Group boxes are drawn around their members; placing inside one is fine
  // only for a member, so new free-standing nodes treat them as taken.
  for (const group of Object.values(mulch.groups)) rects.push({ x: group.x, y: group.y, w: group.w, h: group.h });
  return rects;
}

function centre(rects: Rect[]): { x: number; y: number } {
  const xs = rects.map((r) => r.x + r.w / 2);
  const ys = rects.map((r) => r.y + r.h / 2);
  return { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length };
}

/**
 * A free top-left position for a box of `size`, as close as possible to the
 * anchor nodes (or, without anchors, to `fallback`, else to the most recent
 * nodes, else the origin). Searches rings of candidates around the target
 * and returns the first that collides with nothing.
 */
export function placeNear(
  mulch: Mulch,
  size: { w: number; h: number },
  options: { anchorIds?: string[]; fallback?: { x: number; y: number }; seed?: string; taken?: Rect[] } = {},
): { x: number; y: number } {
  const anchors = (options.anchorIds ?? []).map((id) => mulch.nodes[id]).filter(Boolean).map(rectOf);
  const taken = [...occupied(mulch), ...(options.taken ?? [])];
  let target: { x: number; y: number };
  if (anchors.length) target = centre(anchors);
  else if (options.fallback) target = options.fallback;
  else {
    const recent = Object.values(mulch.nodes)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 6)
      .map(rectOf);
    target = recent.length ? centre(recent) : { x: 0, y: 0 };
  }
  const rnd = jitter(options.seed ?? `${taken.length}`);
  const startAngle = rnd(Math.PI * 2);
  const free = (x: number, y: number) => !taken.some((rect) => overlaps({ x, y, w: size.w, h: size.h }, rect, GAP));

  const cx = target.x - size.w / 2;
  const cy = target.y - size.h / 2;
  if (!anchors.length && free(cx, cy)) return { x: Math.round(cx), y: Math.round(cy) };
  for (let ring = 1; ring <= 60; ring++) {
    const radius = ring * 70;
    const steps = Math.max(8, ring * 6);
    for (let step = 0; step < steps; step++) {
      const angle = startAngle + (step / steps) * Math.PI * 2;
      // Wider than tall: cards are wide, and reading runs left to right.
      const x = cx + Math.cos(angle) * radius * 1.4;
      const y = cy + Math.sin(angle) * radius;
      if (free(x, y)) return { x: Math.round(x), y: Math.round(y) };
    }
  }
  const bottom = Math.max(0, ...taken.map((rect) => rect.y + rect.h));
  return { x: Math.round(cx), y: Math.round(bottom + GAP) };
}

export interface ArrangeGroup {
  title: string;
  nodeIds: string[];
}

export interface ArrangeResult {
  moves: Array<{ id: string; x: number; y: number }>;
  boxes: Array<{ title: string; x: number; y: number; w: number; h: number; nodeIds: string[] }>;
}

export const GROUP_PADDING = 28;
export const GROUP_TITLE = 36;
const GROUP_GAP = 120;

/**
 * Lay groups out as a grid of territories, each packed in rows of up to
 * `columns` nodes, starting at the top-left of the given nodes' current
 * bounding box. Nodes not named in any group are left where they are and
 * treated as obstacles; the block slides right past them if needed.
 */
export function arrangeGroups(mulch: Mulch, groups: ArrangeGroup[], columns = 3): ArrangeResult {
  const used = new Set<string>();
  const packed = groups
    .map((group) => {
      const nodes = group.nodeIds
        .map((id) => mulch.nodes[id])
        .filter((node): node is MulchNode => !!node && !used.has(node.id));
      nodes.forEach((node) => used.add(node.id));
      const rows: MulchNode[][] = [];
      for (let i = 0; i < nodes.length; i += columns) rows.push(nodes.slice(i, i + columns));
      const rects = rows.map((row) => row.map(rectOf));
      const innerW = Math.max(0, ...rects.map((row) => row.reduce((sum, r) => sum + r.w, 0) + GAP * (row.length - 1)));
      const innerH = rects.reduce((sum, row) => sum + Math.max(...row.map((r) => r.h)), 0) + GAP * Math.max(0, rows.length - 1);
      return {
        title: group.title,
        rows,
        rects,
        w: Math.max(240, innerW + GROUP_PADDING * 2),
        h: innerH + GROUP_PADDING * 2 + GROUP_TITLE,
      };
    })
    .filter((group) => group.rows.length > 0);
  if (!packed.length) return { moves: [], boxes: [] };

  const moved = [...used].map((id) => rectOf(mulch.nodes[id]));
  const origin = { x: Math.min(...moved.map((r) => r.x)), y: Math.min(...moved.map((r) => r.y)) };
  const perRow = Math.max(1, Math.ceil(Math.sqrt(packed.length)));

  // Territory positions relative to the block's origin.
  const slots: Array<{ x: number; y: number }> = [];
  let y = 0;
  for (let i = 0; i < packed.length; i += perRow) {
    const line = packed.slice(i, i + perRow);
    let x = 0;
    for (const group of line) {
      slots.push({ x, y });
      x += group.w + GROUP_GAP;
    }
    y += Math.max(...line.map((group) => group.h)) + GROUP_GAP;
  }
  const blockW = Math.max(...packed.map((group, i) => slots[i].x + group.w));
  const blockH = Math.max(...packed.map((group, i) => slots[i].y + group.h));

  // Slide right past anything that stays put, so the block never lands on it.
  const obstacles = occupied(mulch, used).filter((rect) => {
    // Existing group boxes around only-moving nodes are replaced, not avoided.
    return !Object.values(mulch.groups).some(
      (group) => group.x === rect.x && group.y === rect.y && group.w === rect.w && group.h === rect.h,
    );
  });
  let start = origin;
  for (let attempt = 0; attempt < 200; attempt++) {
    const hit = obstacles.find((rect) => overlaps({ ...start, w: blockW, h: blockH }, rect, GAP));
    if (!hit) break;
    start = { x: hit.x + hit.w + GAP * 2, y: start.y };
  }

  const moves: ArrangeResult["moves"] = [];
  const boxes: ArrangeResult["boxes"] = [];
  packed.forEach((group, i) => {
    const gx = start.x + slots[i].x;
    const gy = start.y + slots[i].y;
    let rowY = gy + GROUP_PADDING + GROUP_TITLE;
    group.rows.forEach((row, r) => {
      let colX = gx + GROUP_PADDING;
      row.forEach((node, c) => {
        moves.push({ id: node.id, x: Math.round(colX), y: Math.round(rowY) });
        colX += group.rects[r][c].w + GAP;
      });
      rowY += Math.max(...group.rects[r].map((rect) => rect.h)) + GAP;
    });
    boxes.push({
      title: group.title,
      x: Math.round(gx),
      y: Math.round(gy),
      w: Math.round(group.w),
      h: Math.round(group.h),
      nodeIds: group.rows.flat().map((node) => node.id),
    });
  });
  return { moves, boxes };
}

/** Bounding box of a set of rects, or undefined for none. */
export function boundsOf(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
}

/**
 * The box a group should have around its members, or undefined when it has
 * none or already fits within a pixel.
 */
export function fittedGroupBox(mulch: Mulch, groupId: string): { x: number; y: number; w: number; h: number } | undefined {
  const group = mulch.groups[groupId];
  const members = Object.values(mulch.nodes).filter((node) => node.groupId === groupId);
  const bounds = boundsOf(members.map(rectOf));
  if (!group || !bounds) return undefined;
  const box = {
    x: Math.round(bounds.x - GROUP_PADDING),
    y: Math.round(bounds.y - GROUP_PADDING - GROUP_TITLE),
    w: Math.round(Math.max(240, bounds.w + GROUP_PADDING * 2)),
    h: Math.round(bounds.h + GROUP_PADDING * 2 + GROUP_TITLE),
  };
  const same = Math.abs(box.x - group.x) <= 1 && Math.abs(box.y - group.y) <= 1 && Math.abs(box.w - group.w) <= 1 && Math.abs(box.h - group.h) <= 1;
  return same ? undefined : box;
}
