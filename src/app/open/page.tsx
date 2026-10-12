"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Scribble } from "@/components/brand/Scribble";

/** "Open in mlch": copies a shared canvas or file into a new mulch, then opens it. */
function Open() {
  const router = useRouter();
  const manifest = useSearchParams().get("manifest");
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    void fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest }) })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { mulchId?: string; error?: string };
        if (cancelled) return;
        if (body.mulchId) router.replace(`/n/${body.mulchId}`);
        else setError(body.error ?? "Could not open it.");
      })
      .catch(() => !cancelled && setError("Could not open it."));
    return () => {
      cancelled = true;
    };
  }, [manifest, router]);
  return (
    <main className="h-full grid place-items-center bg-paper">
      {error ? <p className="text-[14px] text-danger">{error}</p> : <Scribble mode="loop" className="w-24 text-ink" />}
    </main>
  );
}

export default function OpenPage() {
  return (
    <Suspense>
      <Open />
    </Suspense>
  );
}
