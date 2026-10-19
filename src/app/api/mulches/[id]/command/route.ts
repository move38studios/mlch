import { guardAgent, handle, jsonError } from "@/lib/http";
import { submitCommand } from "@/lib/agent/jobs";
import { applyToMulch, getMulch } from "@/lib/mulch/store";
import type { MulchComment } from "@/lib/mulch/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** A comment to act on now: one already there (`id`), or a new one written with it. */
function commentFrom(value: unknown): Pick<MulchComment, "id"> & Partial<Pick<MulchComment, "nodeId" | "text" | "at">> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { id, nodeId, text, at } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id || id.length > 80) return undefined;
  const slide = at && typeof at === "object" ? (at as { slide?: unknown }).slide : undefined;
  return {
    id,
    ...(typeof nodeId === "string" ? { nodeId } : {}),
    ...(typeof text === "string" ? { text: text.trim().slice(0, 4000) } : {}),
    ...(typeof slide === "number" && Number.isInteger(slide) && slide > 0 ? { at: { slide } } : {}),
  };
}

export async function POST(request: Request, { params }: Params) {
  const denied = guardAgent(request);
  if (denied) return denied;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { instruction?: unknown; about?: unknown; comment?: unknown };
  const comment = commentFrom(body.comment);
  if (body.comment !== undefined && !comment) return jsonError(400, "A comment needs its id, and to be new its item and text.");
  const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 4000) : "";
  if (!instruction && !comment) return jsonError(400, "Empty instruction.");
  return handle(async () => {
    const mulch = await getMulch(id);
    if (comment) {
      // Do it now: the comment by itself, about its item.
      let existing = mulch.comments?.[comment.id];
      if (!existing) {
        if (!comment.nodeId || !mulch.nodes[comment.nodeId] || !comment.text) return jsonError(400, "That comment isn't there; a new one needs an item on the canvas and text.");
        existing = { id: comment.id, nodeId: comment.nodeId, text: comment.text, ...(comment.at ? { at: comment.at } : {}), createdAt: Date.now() };
        await applyToMulch(id, [{ op: "addComment", comment: existing }], "user");
      }
      if (existing.resolvedAt) return jsonError(400, "That comment is already closed.");
      submitCommand(id, existing.text, { about: [existing.nodeId], comment: existing.id });
      return { ok: true };
    }
    // The cards selected when it was given: what it is about.
    const about = Array.isArray(body.about) ? body.about.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
    submitCommand(id, instruction, { about });
    return { ok: true };
  });
}
