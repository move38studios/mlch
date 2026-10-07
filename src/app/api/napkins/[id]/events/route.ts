import { jsonError } from "@/lib/http";
import { log } from "@/lib/log";
import type { ServerEvent } from "@/lib/napkin/events";
import { resumeGenerations } from "@/lib/media/generations";
import { getNapkin, NapkinNotFoundError, subscribe } from "@/lib/napkin/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Server-sent events: a snapshot, then every change to the napkin. */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    unsubscribe?.();
    clearInterval(keepAlive);
  };
  try {
    // A missing napkin is a 404, not a stream that errors.
    await getNapkin(id);
    // Generations still running from before a restart pick up again.
    await resumeGenerations(id).catch((error) => log.error("media", "resume failed", { napkinId: id, error }));
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: ServerEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        unsubscribe = await subscribe(id, send);
        keepAlive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            close();
          }
        }, 15_000);
        request.signal.addEventListener("abort", () => {
          close();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
      cancel: close,
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
    });
  } catch (error) {
    close();
    if (error instanceof NapkinNotFoundError) return jsonError(404, error.message);
    throw error;
  }
}
