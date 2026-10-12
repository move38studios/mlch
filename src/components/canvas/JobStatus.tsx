"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw, Square, X } from "lucide-react";
import { Scribble } from "@/components/brand/Scribble";
import { useMulch } from "@/lib/mulch/client";
import type { JobStatus as Job } from "@/lib/mulch/events";

const LANE_LABEL: Record<Job["lane"], string> = { fast: "Capture", slow: "Enrich", command: "Instruction", ingest: "Reading", long: "Making" };

/** Finished results stay listed this long. */
const RECENT_MS = 30 * 60_000;

/** Re-renders every `ms` while `active`, for running clocks. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

export function elapsed(from: number | undefined, now: number): string {
  const seconds = Math.max(0, Math.floor((now - (from ?? now)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function clock(at: number | undefined): string {
  return at ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}

const isActive = (job: Job) => job.state === "running" || job.state === "queued";

/** What the activity list shows, most pressing first. */
function listed(jobs: Job[], now: number): Job[] {
  const rank = (job: Job) => (job.state === "running" ? (job.lane === "long" ? 0 : 1) : job.state === "queued" ? 2 : job.state === "failed" ? 3 : 4);
  return jobs
    .filter(
      (job) =>
        isActive(job) ||
        (job.retry && job.state === "failed" && job.unseen) ||
        (job.retry && job.state === "done" && job.resultIds?.length && (job.unseen || now - (job.finishedAt ?? 0) < RECENT_MS)),
    )
    .sort((a, b) => rank(a) - rank(b) || (b.finishedAt ?? b.startedAt ?? b.queuedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? a.queuedAt ?? 0));
}

function JobRow({ job, now }: { job: Job; now: number }) {
  const jobAction = useMulch((s) => s.jobAction);
  const setFocus = useMulch((s) => s.setFocus);
  const mulch = useMulch((s) => s.mulch);
  const results = (job.resultIds ?? []).filter((id) => mulch?.nodes[id]);
  const detail =
    job.state === "running"
      ? (job.activity ?? LANE_LABEL[job.lane])
      : job.state === "queued"
        ? "Queued"
        : job.state === "failed"
          ? (job.error ?? "Failed")
          : `${results.length} ${results.length === 1 ? "item" : "items"}`;
  return (
    <li className="flex items-start gap-2.5 px-3 py-2.5">
      <div className="pt-1.5 w-7 shrink-0">
        {job.state === "running" ? (
          <Scribble which="bottom" mode="loop" strokeWidth={11} className="h-2.5 w-7 text-ink" />
        ) : job.state === "failed" ? (
          <span className="block h-2 w-2 mt-0.5 rounded-full bg-danger" />
        ) : job.state === "done" && job.unseen ? (
          <span className="block h-2 w-2 mt-0.5 rounded-full bg-amber" />
        ) : (
          <span className="block h-2 w-2 mt-0.5 rounded-full bg-line-2" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-medium text-ink" title={job.label}>
            {job.label}
          </span>
          <span className="ml-auto shrink-0 tabular-nums text-[12px] text-ink-3">
            {job.state === "running" ? elapsed(job.startedAt, now) : job.state === "done" || job.state === "failed" ? clock(job.finishedAt) : ""}
          </span>
        </div>
        <p className={`mt-0.5 text-[12px] leading-snug line-clamp-2 ${job.state === "failed" ? "text-danger" : "text-ink-3"}`}>{detail}</p>
        {job.message && <p className="mt-1.5 text-[12.5px] leading-snug text-ink-2 whitespace-pre-line line-clamp-6">{job.message.text}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {isActive(job) && (
          <button onClick={() => void jobAction("cancel", { jobId: job.id })} className="p-1.5 rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" title="Stop" aria-label="Stop">
            <Square size={11} strokeWidth={2} />
          </button>
        )}
        {job.state === "done" && results.length > 0 && (
          <button
            onClick={() => {
              setFocus({ ids: results });
              void jobAction("seen", { ids: [job.id] });
            }}
            className="px-2 py-1 rounded-md text-[12px] font-medium text-ink hover:bg-paper-2"
          >
            Show
          </button>
        )}
        {job.state === "failed" && (
          <>
            <button onClick={() => void jobAction("retry", { jobId: job.id })} className="p-1.5 rounded-md text-ink-2 hover:bg-paper-2 hover:text-ink" title="Retry" aria-label="Retry">
              <RotateCcw size={12} strokeWidth={2} />
            </button>
            <button onClick={() => void jobAction("seen", { ids: [job.id] })} className="p-1.5 rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" title="Dismiss" aria-label="Dismiss">
              <X size={12} strokeWidth={2} />
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * What the AI is working on. One control in the top bar: the scribble moves
 * while anything runs; an amber dot means finished results you haven't seen,
 * a red one a failure. Its list has each job with what it is doing now, stop,
 * show and retry.
 */
export function JobStatus({ mulchId }: { mulchId: string }) {
  const jobs = Object.values(useMulch((s) => s.jobs));
  const paused = useMulch((s) => s.paused);
  const say = useMulch((s) => s.say);
  const [showSay, setShowSay] = useState(false);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const active = jobs.filter(isActive);
  const now = useNow(active.length > 0 || open);
  const rows = listed(jobs, now);
  const unseen = jobs.some((job) => job.retry && job.state === "done" && job.unseen);
  const failed = jobs.some((job) => job.retry && job.state === "failed" && job.unseen);

  useEffect(() => {
    if (!say) return;
    setShowSay(true);
    const timer = setTimeout(() => setShowSay(false), 8000);
    return () => clearTimeout(timer);
  }, [say]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const post = (path: string, body?: unknown) =>
    fetch(`/api/mulches/${mulchId}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

  // The button names the person's own request when one runs, else the lane.
  const runningKept = active.filter((job) => job.retry);
  const lead = runningKept.find((job) => job.state === "running") ?? runningKept[0] ?? active.find((job) => job.state === "running");
  const more = (runningKept.length || active.length) - 1;
  const label = lead ? (lead.retry ? lead.label : LANE_LABEL[lead.lane]) : undefined;

  return (
    <div className="flex items-center gap-1 text-[12.5px] text-ink-2">
      {showSay && say && <span className="max-w-72 truncate text-ink-3 px-1.5">{say.text}</span>}
      {(rows.length > 0 || active.length > 0) && (
        <div ref={box} className="relative">
          <button
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label="Activity"
            className={`inline-flex items-center gap-1.5 rounded-lg pl-1.5 pr-2 h-7 ${open ? "bg-paper-2" : "hover:bg-paper-2"}`}
          >
            {active.length > 0 ? (
              <Scribble which="bottom" mode="loop" strokeWidth={11} className="h-3 w-8 text-ink" />
            ) : (
              <span className={`h-2 w-2 rounded-full ${failed ? "bg-danger" : unseen ? "bg-amber" : "bg-line-2"}`} />
            )}
            {label ? <span className="max-w-44 truncate text-ink">{label}</span> : <span className="text-ink">{rows.length}</span>}
            {label && more > 0 && <span className="text-ink-3">+{more}</span>}
            {label && (failed || unseen) && <span className={`h-1.5 w-1.5 rounded-full ${failed ? "bg-danger" : "bg-amber"}`} />}
          </button>
          {open && (
            <div className="float absolute right-0 top-9 z-30 w-[340px] rounded-xl overflow-hidden">
              <ul className="max-h-[60vh] overflow-auto divide-y divide-line">
                {rows.map((job) => (
                  <JobRow key={job.id} job={job} now={now} />
                ))}
              </ul>
              {active.length > 1 && (
                <div className="border-t border-line px-3 py-2 flex justify-end">
                  <button onClick={() => void post("cancel")} className="px-2 py-1 rounded-md text-[12px] text-ink-2 hover:bg-paper-2 hover:text-ink">
                    Stop all
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
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
