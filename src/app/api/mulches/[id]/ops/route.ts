import { handle, jsonError } from "@/lib/http";
// Registers the checkpoint hook for edits.
import "@/lib/mulch/history";
// Registers the search index hook.
import "@/lib/search";
// Registers the naming of untitled mulches.
import "@/lib/agent/jobs";
import { parseOps } from "@/lib/mulch/schema";
import { applyToMulch, getMulch } from "@/lib/mulch/store";
import type { MulchOp } from "@/lib/mulch/types";
import { addWord, corrections } from "@/lib/words/words";
import { projectOf } from "@/lib/projects/projects";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const parsed = parseOps(await request.json().catch(() => null));
  if (!parsed.ok) return jsonError(400, parsed.error);
  return handle(async () => {
    // Text from speech before the person's edit: a name or term they fix is learned (words.ts).
    const before = await spokenBefore(id, parsed.ops);
    const batch = await applyToMulch(id, parsed.ops, "user", parsed.clientId);
    if (batch && before.size) void learnFromEdits(id, before, parsed.ops).catch(() => {});
    return { batchId: batch?.id ?? null };
  });
}

/** The text of cards from speech that these ops edit, as it was. */
async function spokenBefore(id: string, ops: MulchOp[]): Promise<Map<string, string>> {
  const edits = ops.filter((op): op is Extract<MulchOp, { op: "updateNode" }> => op.op === "updateNode" && op.patch.text != null);
  if (!edits.length) return new Map();
  const mulch = await getMulch(id).catch(() => undefined);
  const before = new Map<string, string>();
  for (const op of edits) {
    const node = mulch?.nodes[op.id];
    if (node?.origin.startsWith("speech:")) before.set(op.id, node.text);
  }
  return before;
}

async function learnFromEdits(id: string, before: Map<string, string>, ops: MulchOp[]): Promise<void> {
  const project = await projectOf(id);
  for (const op of ops) {
    if (op.op !== "updateNode" || op.patch.text == null || !before.has(op.id)) continue;
    for (const [heard, term] of corrections(before.get(op.id)!, op.patch.text)) await addWord({ term, heard: [heard], project: project?.id, from: "edit" });
  }
}
