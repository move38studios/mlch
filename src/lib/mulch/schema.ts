/** Runtime validation for ops arriving from the browser. */

import { z } from "zod";
import { NODE_KINDS, type MulchOp } from "./types";

const id = z.string().min(1).max(80);
const num = z.number().finite();
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

const gen = z.object({
  id: z.string().max(80),
  endpoint: z.string().max(200),
  status: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  position: z.number().optional(),
  log: z.string().max(500).optional(),
  error: z.string().max(2000).optional(),
  cost: z.number().optional(),
  startedAt: num,
  finishedAt: num.optional(),
});

const nodeFields = {
  kind: z.enum(NODE_KINDS as [string, ...string[]]),
  x: num,
  y: num,
  w: num.positive().optional(),
  h: num.positive().optional(),
  title: z.string().max(500).optional(),
  text: z.string().max(200_000),
  url: z.string().max(4000).optional(),
  assetId: z.string().max(128).optional(),
  fileName: z.string().max(500).optional(),
  docPath: z.string().max(500).optional(),
  artifactKind: z.enum(["deck", "page"]).optional(),
  groupId: id.optional(),
  mime: z.string().max(100).optional(),
  poster: z.string().max(200).optional(),
  gen: gen.optional(),
  origin: z.string().max(120),
  userTouched: z.boolean().optional(),
  ref: z.union([z.object({ mulchId: id, itemId: id }).strict(), z.object({ sourceId: id, path: z.string().min(1).max(1000) }).strict()]).optional(),
  updatedAt: num.optional(),
};

const node = z.object({ id, createdAt: num, ...nodeFields });

const nodePatch = z.object({
  kind: nullable(nodeFields.kind),
  x: num.optional(),
  y: num.optional(),
  w: nullable(num.positive()),
  h: nullable(num.positive()),
  title: nullable(z.string().max(500)),
  text: z.string().max(200_000).optional(),
  url: nullable(z.string().max(4000)),
  assetId: nullable(z.string().max(128)),
  fileName: nullable(z.string().max(500)),
  docPath: nullable(z.string().max(500)),
  artifactKind: nullable(z.enum(["deck", "page"])),
  groupId: nullable(id),
  mime: nullable(z.string().max(100)),
  poster: nullable(z.string().max(200)),
  gen: nullable(gen),
  origin: z.string().max(120).optional(),
  userTouched: nullable(z.boolean()),
  updatedAt: nullable(num),
});

const edge = z.object({
  id,
  source: id,
  target: id,
  label: z.string().max(200).optional(),
  origin: z.string().max(120),
  createdAt: num,
});

const group = z.object({
  id,
  title: z.string().max(200),
  x: num,
  y: num,
  w: num.positive(),
  h: num.positive(),
  origin: z.string().max(120),
  userTouched: z.boolean().optional(),
  createdAt: num,
});

const groupPatch = z.object({
  title: z.string().max(200).optional(),
  x: num.optional(),
  y: num.optional(),
  w: num.positive().optional(),
  h: num.positive().optional(),
  origin: z.string().max(120).optional(),
  userTouched: nullable(z.boolean()),
});

export const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addNode"), node }),
  z.object({ op: z.literal("updateNode"), id, patch: nodePatch }),
  z.object({ op: z.literal("removeNode"), id }),
  z.object({ op: z.literal("addEdge"), edge }),
  z.object({ op: z.literal("updateEdge"), id, patch: z.object({ label: nullable(z.string().max(200)) }) }),
  z.object({ op: z.literal("removeEdge"), id }),
  z.object({ op: z.literal("addGroup"), group }),
  z.object({ op: z.literal("updateGroup"), id, patch: groupPatch }),
  z.object({ op: z.literal("removeGroup"), id }),
  z.object({ op: z.literal("setTitle"), title: z.string().max(200) }),
]);

export const opsRequestSchema = z.object({
  clientId: z.string().max(64).optional(),
  ops: z.array(opSchema).max(2000),
});

export function parseOps(value: unknown): { ok: true; ops: MulchOp[]; clientId?: string } | { ok: false; error: string } {
  const parsed = opsRequestSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { ok: true, ops: parsed.data.ops as MulchOp[], clientId: parsed.data.clientId };
}
