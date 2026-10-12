"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Scribble } from "@/components/brand/Scribble";

/** New (menu bar, shortcut, first run): a fresh mulch; `?call=1` listens to a call in it, `?mic=1` starts the microphone. */
function NewMulch() {
  const router = useRouter();
  const params = useSearchParams();
  const call = params.get("call") === "1";
  const mic = params.get("mic") === "1";
  const [error, setError] = useState<string>();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void fetch("/api/mulches", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then((response) => response.json() as Promise<{ mulch?: { id: string }; error?: string }>)
      .then((body) => (body.mulch ? router.replace(`/n/${body.mulch.id}${call ? "?call=1" : mic ? "?mic=1" : ""}`) : setError(body.error ?? "Could not start a new one.")))
      .catch(() => setError("Could not start a new one."));
  }, [call, mic, router]);
  return <main className="h-full grid place-items-center bg-paper">{error ? <p className="text-[14px] text-danger">{error}</p> : <Scribble mode="loop" className="w-24 text-ink" />}</main>;
}

export default function NewPage() {
  return (
    <Suspense>
      <NewMulch />
    </Suspense>
  );
}
