"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { desktop } from "@/lib/desktop/client";
import { useMulch } from "@/lib/mulch/client";

/** One frame of a window or screen the person picks in macOS's picker, as a PNG file. */
async function captureFrame(): Promise<File> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const track = stream.getVideoTracks()[0];
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // Let a real frame arrive.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The screenshot could not be made.");
    const stamp = new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" }).replace(/[/:]/g, "-");
    const what = track?.label && !/^(screen|window|web-contents-media-stream)/i.test(track.label) ? `${track.label} ` : "";
    return new File([blob], `Screenshot ${what}${stamp}.png`.replace(/\s+/g, " "), { type: "image/png" });
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

/**
 * Screenshots to the canvas (⌘⇧2 anywhere, or File menu): main asks the page,
 * the page opens macOS's window picker and adds the picked window as an image
 * card to the open mulch, or to a new one. The image lane then looks at it.
 */
export function ScreenshotListener() {
  const router = useRouter();
  useEffect(() => {
    const onRequest = async () => {
      let file: File;
      try {
        file = await captureFrame();
      } catch (error) {
        // Cancelling the picker is not an error.
        if ((error as Error).name !== "NotAllowedError" && (error as Error).name !== "AbortError") {
          useMulch.setState({ notice: { level: "error", message: (error as Error).message, at: Date.now() } });
        }
        return;
      }
      void desktop()?.showWindow?.();
      const open = location.pathname.match(/^\/n\/([^/]+)/)?.[1];
      if (open) {
        // The canvas places it in the middle of the view.
        window.dispatchEvent(new CustomEvent("mlch:add-file", { detail: file }));
        return;
      }
      const created = (await (await fetch("/api/mulches", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as { mulch?: { id: string } };
      const id = created.mulch?.id;
      if (!id) return;
      await fetch(`/api/mulches/${id}/files?name=${encodeURIComponent(file.name)}&x=0&y=0`, { method: "POST", body: file });
      router.push(`/n/${id}`);
    };
    window.addEventListener("mlch:screenshot", onRequest);
    return () => window.removeEventListener("mlch:screenshot", onRequest);
  }, [router]);
  return null;
}
