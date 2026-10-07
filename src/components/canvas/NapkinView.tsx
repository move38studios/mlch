"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import { useNapkin } from "@/lib/napkin/client";
import { Canvas } from "./Canvas";
import { InputBar } from "./InputBar";
import { JobStatus } from "./JobStatus";
import { SidePanel } from "./SidePanel";

function Title() {
  const napkin = useNapkin((s) => s.napkin);
  const apply = useNapkin((s) => s.apply);
  const [value, setValue] = useState<string>();
  if (!napkin) return null;
  const commit = () => {
    if (value !== undefined && value.trim() && value.trim() !== napkin.title) apply([{ op: "setTitle", title: value.trim() }]);
    setValue(undefined);
  };
  return (
    <input
      value={value ?? napkin.title}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setValue(undefined);
          (e.target as HTMLInputElement).blur();
        }
      }}
      aria-label="Title"
      className="min-w-0 w-80 bg-transparent font-semibold outline-none rounded px-1.5 py-0.5 hover:bg-paper-2 focus:bg-white"
    />
  );
}

function Notice() {
  const notice = useNapkin((s) => s.notice);
  const dismiss = useNapkin((s) => s.dismissNotice);
  useEffect(() => {
    if (!notice || notice.level === "error") return;
    const timer = setTimeout(dismiss, 5000);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);
  if (!notice) return null;
  return (
    <div className={`absolute top-3 left-1/2 -translate-x-1/2 z-20 max-w-xl flex items-start gap-2 rounded-md px-3 py-2 text-sm shadow-md ${notice.level === "error" ? "bg-accent text-white" : "bg-ink text-paper"}`}>
      <span className="flex-1">{notice.message}</span>
      <button onClick={dismiss} aria-label="Close" className="opacity-70 hover:opacity-100">
        <X size={14} />
      </button>
    </div>
  );
}

export function NapkinView({ id }: { id: string }) {
  const connect = useNapkin((s) => s.connect);
  const napkin = useNapkin((s) => (s.id === id ? s.napkin : undefined));
  const connected = useNapkin((s) => s.connected);
  const error = useNapkin((s) => s.error);

  useEffect(() => connect(id), [connect, id]);

  return (
    <main className="h-full flex flex-col">
      <header className="drag h-12 shrink-0 pl-20 pr-3 flex items-center gap-2 border-b border-line bg-paper z-10">
        <Link href="/" className="p-1.5 rounded-md text-ink-2 hover:bg-paper-2" aria-label="Napkins" title="Napkins">
          <ArrowLeft size={16} />
        </Link>
        <Title />
        <div className="flex-1" />
        {!connected && napkin && <span className="text-xs text-ink-3">Reconnecting</span>}
        {napkin && <JobStatus napkinId={id} />}
      </header>
      <div className="relative flex-1 min-h-0 flex">
        <div className="relative flex-1 min-w-0">
          <Notice />
          {error ? (
            <p className="p-8 text-sm text-ink-2">{error}</p>
          ) : napkin ? (
            <>
              <Canvas napkin={napkin} />
              <InputBar napkinId={id} />
            </>
          ) : null}
        </div>
        <SidePanel />
      </div>
    </main>
  );
}
