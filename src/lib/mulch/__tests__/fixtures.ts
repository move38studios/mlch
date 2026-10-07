import { emptyMulch } from "../ops";
import type { Mulch, MulchNode } from "../types";

export function node(id: string, overrides: Partial<MulchNode> = {}): MulchNode {
  return { id, kind: "idea", x: 0, y: 0, text: id, origin: "user", createdAt: 1, ...overrides };
}

export function mulchWith(...nodes: MulchNode[]): Mulch {
  const mulch = emptyMulch("n1", "Test", 1);
  for (const n of nodes) mulch.nodes[n.id] = n;
  return mulch;
}
