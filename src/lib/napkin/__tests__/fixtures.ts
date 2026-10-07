import { emptyNapkin } from "../ops";
import type { Napkin, NapkinNode } from "../types";

export function node(id: string, overrides: Partial<NapkinNode> = {}): NapkinNode {
  return { id, kind: "idea", x: 0, y: 0, text: id, origin: "user", createdAt: 1, ...overrides };
}

export function napkinWith(...nodes: NapkinNode[]): Napkin {
  const napkin = emptyNapkin("n1", "Test", 1);
  for (const n of nodes) napkin.nodes[n.id] = n;
  return napkin;
}
