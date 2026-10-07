"use client";

import { useEffect, useState } from "react";
import { Pause, Play, Square } from "lucide-react";
import { Scribble } from "@/components/brand/Scribble";
import { useMulch } from "@/lib/mulch/client";
import type { JobStatus as Job } from "@/lib/mulch/events";

const LANE_LABEL: Record<Job["lane"], string> = { fast: "Capture", slow: "Enrich", command: "Instruction", ingest: "Reading" };

/** Running agent work, the agent's last status line, and pause / stop. */
export function JobStatus({ mulchId }: { mulchId: string }) {
  const jobs = useMulch((s) => s.jobs);
  const paused = useMulch((s) => s.paused);
  const say = useMulch((s) => s.say);
  const [showSay, setShowSay] = useState(false);
  const running = Object.values(jobs).filter((job) => job.state === "running" || job.state === "queued");

  useEffect(() => {
    if (!say) return;
    setShowSay(true);
    const timer = setTimeout(() => setShowSay(false), 8000);
    return () => clearTimeout(timer);
  }, [say]);

  const post = (path: string, body?: unknown) =>
    fetch(`/api/mulches/${mulchId}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

  return (
    <div className="flex items-center gap-1 text-[12.5px] text-ink-2">
      {showSay && say && <span className="max-w-72 truncate text-ink-3 px-1.5">{say.text}</span>}
      {running.map((job) => (
        <span key={job.id} className="inline-flex items-center gap-1.5 rounded-lg bg-paper-2 pl-1.5 pr-2 h-7" title={job.label}>
          <Scribble which="bottom" mode="loop" strokeWidth={11} className="h-3 w-auto text-ink" />
          <span className="text-ink">{LANE_LABEL[job.lane]}</span>
          {job.lane === "command" && <span className="max-w-40 truncate text-ink-3">{job.label}</span>}
        </span>
      ))}
      {running.length > 0 && (
        <button onClick={() => post("cancel")} className="p-1.5 rounded-lg hover:bg-paper-2 hover:text-ink" title="Stop" aria-label="Stop">
          <Square size={12} strokeWidth={2} />
        </button>
      )}
      <button
        onClick={() => post("pause", { paused: !paused })}
        className={`inline-flex items-center gap-1.5 rounded-lg px-2 h-7 hover:bg-paper-2 ${paused ? "bg-amber text-ink font-medium hover:bg-amber" : "hover:text-ink"}`}
        title={paused ? "Resume enrichment" : "Pause enrichment"}
      >
        {paused ? <Play size={12} strokeWidth={2} /> : <Pause size={12} strokeWidth={2} />}
        {paused ? "Enrichment paused" : "Enrichment"}
      </button>
    </div>
  );
}
