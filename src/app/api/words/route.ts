import { handle, jsonError } from "@/lib/http";
import { addWord, readWords, removeWord } from "@/lib/words/words";

export const dynamic = "force-dynamic";

/** The words mlch has learned (words.ts), newest first. */
export async function GET() {
  return handle(async () => ({ words: [...(await readWords())].sort((a, b) => b.at - a.at) }));
}

/** POST {term, heard?, project?}: added by the person. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { term?: unknown; heard?: unknown; project?: unknown };
  if (typeof body.term !== "string" || !body.term.trim()) return jsonError(400, "Give the word.");
  const heard = Array.isArray(body.heard) ? body.heard.filter((h): h is string => typeof h === "string") : typeof body.heard === "string" ? body.heard.split(",") : [];
  const project = typeof body.project === "string" && body.project ? body.project : undefined;
  const term = body.term;
  return handle(async () => {
    const word = await addWord({ term, heard, project, from: "person" });
    if (!word) return jsonError(400, "A word is at most 80 characters.");
    return { word };
  });
}

/** DELETE ?id=: forget a word. */
export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return jsonError(400, "Give the word's id.");
  return handle(async () => {
    await removeWord(id);
    return { ok: true };
  });
}
