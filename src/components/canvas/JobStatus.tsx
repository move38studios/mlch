"use client";

import { useEffect, useState } from "react";
import { Loader2, Pause, Play, Square } from "lucide-react";
import { useNapkin } from "@/lib/napkin/client";
import type { JobStatus as Job } from "@/lib/napkin/events";

const LANE_LABEL: Record<Job["lane"], string> = { fast: "Capture", slow: "Enrich", command: "Instruction", ingest: "Reading" };

/** Running agent work, the agent's last status line, and pause / stop. */
export function JobStatus({ napkinId }: { napkinId: string }) {
  const jobs = useNapkin((s) => s.jobs);
  const paused = useNapkin((s) => s.paused);
  const say = useNapkin((s) => s.say);
  const [showSay, setShowSay] = useState(false);
  const running = Object.values(jobs).filter((job) => job.state === "running" || job.state === "queued");

  useEffect(() => {
    if (!say) return;
    setShowSay(true);
    const timer = setTimeout(() => setShowSay(false), 8000);
    return () => clearTimeout(timer);
  }, [say]);

  const post = (path: string, body?: unknown) =>
    fetch(`/api/napkins/${napkinId}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

  return (
    <div className="flex items-center gap-2 text-xs text-ink-2">
      {showSay && say && <span className="max-w-80 truncate text-ink-3">{say.text}</span>}
      {running.map((job) => (
        <span key={job.id} className="inline-flex items-center gap-1 rounded-full bg-paper-2 px-2 py-0.5" title={job.label}>
          <Loader2 size={11} className="animate-spin" />
          {LANE_LABEL[job.lane]}
          {job.lane === "command" && <span className="max-w-40 truncate text-ink-3">{job.label}</span>}
        </span>
      ))}
      {running.length > 0 && (
        <button onClick={() => post("cancel")} className="p-1 rounded hover:bg-paper-2" title="Stop" aria-label="Stop">
          <Square size={12} />
        </button>
      )}
      <button
        onClick={() => post("pause", { paused: !paused })}
        className={`inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-paper-2 ${paused ? "text-accent" : ""}`}
        title={paused ? "Resume enrichment" : "Pause enrichment"}
      >
        {paused ? <Play size={12} /> : <Pause size={12} />}
        {paused ? "Enrichment paused" : "Enrichment"}
      </button>
    </div>
  );
}
